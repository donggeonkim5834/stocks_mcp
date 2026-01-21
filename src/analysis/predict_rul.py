import os
import math
import random
import pandas as pd
import numpy as np
import torch
from torch import nn
from pathlib import Path
from sklearn.preprocessing import StandardScaler

# 시드 설정
def set_seed(seed=42):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False

# 포지셔널 인코딩
def add_positional_encoding(x: torch.Tensor) -> torch.Tensor:
    B, L, D = x.size()
    device = x.device
    pos = torch.arange(L, device=device).unsqueeze(1).float()
    div = torch.exp(torch.arange(0, D, 2, device=device).float() * (-math.log(10000.0) / D))
    pe = torch.zeros(L, D, device=device)
    pe[:, 0::2] = torch.sin(pos * div)
    pe[:, 1::2] = torch.cos(pos * div)
    return x + pe.unsqueeze(0).expand(B, -1, -1)

# 모델 구성
class SelfAttention(nn.Module):
    def __init__(self, d_model, heads):
        super().__init__()
        assert d_model % heads == 0
        self.h, self.dk = heads, d_model // heads
        self.qkv = nn.Linear(d_model, d_model * 3)
        self.out = nn.Linear(d_model, d_model)
    def forward(self, x):
        B, L, D = x.shape
        qkv = self.qkv(x).view(B, L, 3, self.h, self.dk).permute(2, 0, 3, 1, 4)
        Q, K, V = qkv[0], qkv[1], qkv[2]
        A = torch.softmax((Q @ K.transpose(-2, -1)) / math.sqrt(self.dk), dim=-1)
        return self.out((A @ V).transpose(1, 2).reshape(B, L, D)) + x

class MultiHeadCrossAttention(nn.Module):
    def __init__(self, d_model, heads):
        super().__init__()
        assert d_model % heads == 0
        self.h, self.dk = heads, d_model // heads
        self.q = nn.Linear(d_model, d_model)
        self.kv = nn.Linear(d_model, d_model * 2)
        self.out = nn.Linear(d_model, d_model)
    def forward(self, x, memory):
        B, T, D = x.shape
        S = memory.shape[1]
        Q = self.q(x).view(B, T, self.h, self.dk).permute(0, 2, 1, 3)
        kv = self.kv(memory).view(B, S, 2, self.h, self.dk).permute(2, 0, 3, 1, 4)
        K, V = kv[0], kv[1]
        A = torch.softmax((Q @ K.transpose(-2, -1)) / math.sqrt(self.dk), dim=-1)
        return self.out((A @ V).transpose(1, 2).reshape(B, T, D)) + x

class FeedForward(nn.Module):
    def __init__(self, d_model, hidden):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d_model, hidden), nn.GELU(), nn.Linear(hidden, d_model))
    def forward(self, x):
        return self.net(x) + x

class Encoder(nn.Module):
    def __init__(self, layers, d_model, heads, hidden):
        super().__init__()
        self.layers = nn.ModuleList([
            nn.Sequential(SelfAttention(d_model, heads), FeedForward(d_model, hidden))
            for _ in range(layers)
        ])
    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x

class Decoder(nn.Module):
    def __init__(self, layers, d_model, heads, hidden):
        super().__init__()
        self.self_layers = nn.ModuleList([SelfAttention(d_model, heads) for _ in range(layers)])
        self.cross_layers = nn.ModuleList([MultiHeadCrossAttention(d_model, heads) for _ in range(layers)])
        self.ffns = nn.ModuleList([FeedForward(d_model, hidden) for _ in range(layers)])
    def forward(self, tgt, enc_out):
        x = tgt
        for sa, ca, ff in zip(self.self_layers, self.cross_layers, self.ffns):
            x = sa(x); x = ca(x, enc_out); x = ff(x)
        return x

class RULHead(nn.Module):
    def __init__(self, d_model, hidden_dims=[128, 64]):
        super().__init__()
        layers = []
        in_dim = d_model
        for h in hidden_dims:
            layers += [nn.Linear(in_dim, h), nn.GELU()]
            in_dim = h
        layers.append(nn.Linear(in_dim, 1))
        self.net = nn.Sequential(*layers)
    def forward(self, x):
        return self.net(x[:, -1, :]).squeeze(-1)

# 추론 함수
def infer_rul_without_gt(model_paths, data_dir, output_csv_path, feature_dim=36, window_size=21):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    set_seed()

    # 모델 정의 (학습 모델과 일치)
    encoder = Encoder(layers=3, d_model=feature_dim, heads=4, hidden=256).to(device)
    decoder = Decoder(layers=3, d_model=feature_dim, heads=4, hidden=256).to(device)
    rul_head = RULHead(d_model=feature_dim, hidden_dims=[128, 64]).to(device)

    # 가중치 불러오기
    encoder.load_state_dict(torch.load(model_paths["encoder"], map_location=device))
    decoder.load_state_dict(torch.load(model_paths["decoder"], map_location=device))
    rul_head.load_state_dict(torch.load(model_paths["regressor"], map_location=device))

    encoder.eval(); decoder.eval(); rul_head.eval()

    best_matches = {
        "validation1": "train3.csv",
        "validation2": "train5.csv",
        "validation3": "train5.csv",
        "validation4": "train5.csv",
        "validation5": "train7.csv",
        "validation6": "train5.csv"
    }

    results = []

    for val_name, train_file in best_matches.items():
        val_csv = Path(base_dir) / "validation" / "feature" / f"{val_name}.csv"

        train_csv = Path(data_dir) / train_file
        val_df = pd.read_csv(val_csv)
        train_df = pd.read_csv(train_csv)

        train_tensor = torch.tensor(train_df.values[:, :feature_dim], dtype=torch.float32).unsqueeze(0).to(device)
        train_tensor = add_positional_encoding(train_tensor)

        val_tensor = torch.tensor(val_df.values[:, :feature_dim], dtype=torch.float32).to(device)
        dec_input = val_tensor[-window_size:].unsqueeze(0).to(device)  # Positional encoding 없이
        dec_input = add_positional_encoding(dec_input)

        with torch.no_grad():
            enc_out = encoder(train_tensor)
            dec_out = decoder(dec_input, enc_out)
            pred_log_rul = rul_head(dec_out)
            pred_rul = math.pow(100, pred_log_rul.item()) - 1

        results.append({
            "Validation": val_name,
            "Best_Train": train_file,
            "Pred_RUL": pred_rul
        })
        print(f"{val_name} → {train_file}: Predicted RUL = {pred_rul:.2f}")

    results_df = pd.DataFrame(results)
    results_df.to_csv(output_csv_path, index=False)
    print(f"\n✅ 예측 결과 저장됨: {output_csv_path}")
    return results_df

# 메인 실행
if __name__ == "__main__":
    base_dir = r"C:\Users\USER\Desktop\data"
    data_dir = os.path.join(base_dir, "train_data", "feature", "final_train_data")
    # model_dir = os.path.join(base_dir, "train_data", "feature", "final_train_data")
    model_dir=r"C:\Users\USER\Desktop\PHM_Challenge\train_data\feature\final_train_data\saved_models"
    output_dir = os.path.join(base_dir, "validation", "feature", "results")
    os.makedirs(output_dir, exist_ok=True)

    model_paths = {
        "encoder": os.path.join(model_dir, "encoder.pth"),
        "decoder": os.path.join(model_dir, "decoder.pth"),
        "regressor": os.path.join(model_dir, "head.pth")
    }

    output_csv_path = os.path.join(output_dir, "inference_result.csv")
    results = infer_rul_without_gt(model_paths, data_dir, output_csv_path)
    print(results[["Validation", "Best_Train", "Pred_RUL"]])

# Stocks MCP Server - User Manual

This document provides a comprehensive guide to installing, configuring, and using the Stocks MCP Server.

## Table of Contents
1.  [Prerequisites](#1-prerequisites)
2.  [Installation](#2-installation)
3.  [Configuration (API Keys)](#3-configuration-api-keys)
4.  [Running the Server](#4-running-the-server)
5.  [Tool Reference](#5-tool-reference)
    - [get_fred_data](#get_fred_data)
    - [get_edgar_data](#get_edgar_data)
    - [get_massive_data](#get_massive_data)
    - [calculate_local_indicators](#calculate_local_indicators)
    - [get_social_sentiment](#get_social_sentiment)
6.  [Advanced Usage](#6-advanced-usage)
    - [Claude Desktop Integration](#claude-desktop-integration)
    - [Inspecting the Database](#inspecting-the-database)
    - [Build for Deployment](#build-for-deployment)
7.  [Troubleshooting](#7-troubleshooting)
8.  [Legal & Usage Notes](#8-legal--usage-notes)

---

## 1. Prerequisites

- **Node.js:** Version 20 or higher.
- **npm:** Included with Node.js.
- **git:** For cloning the repository.
- **Windows Users:** It is **highly recommended** to run all commands in `cmd.exe` (Command Prompt) instead of PowerShell to avoid potential script execution policy issues.

---

## 2. Installation

```bash
# 1. Clone the repository (if you haven't already)
git clone <repository_url>
cd stocks_mcp

# 2. Navigate to the source directory
cd src

# 3. Install dependencies
npm install
```

---

## 3. Configuration (API Keys)

The server requires API keys for its data sources. These should be stored in a `.env` file.

1.  Create a new file named `.env` inside the `src` directory.
2.  Add the following variables to the file, replacing `your_..._key` with your actual API keys.

```dotenv
# Path to the local SQLite database file.
DB_PATH=./data/stocks.sqlite

# API Key for Federal Reserve Economic Data (FRED).
# Get a free key at: https://fred.stlouisfed.org/docs/api/api_key.html
FRED_API_KEY=your_fred_key

# API Key for Massive.com data services.
# This is the primary provider for stock quotes, options, etc.
MASSIVE_API_KEY=your_massive_key

# User agent for accessing the SEC EDGAR database.
# This MUST be in the format "YourCompanyName contact@example.com".
EDGAR_USER_AGENT=MyResearch App contact@myresearch.com

# (Optional) API Key for Trading Economics.
TRADING_ECONOMICS_KEY=key:secret
```
**⚠️ Important:** Never commit your `.env` file or API keys to version control (e.g., Git).

---

## 4. Running the Server

### Development Mode (Recommended)

This command uses `tsx` to run the TypeScript server directly with hot-reloading.

```bash
# From the src directory
npm run dev
```

### Direct Launch

This is the recommended method for production or for integration with MCP clients.

```bash
# From the src directory
npx tsx src/server.ts
```

---

## 5. Tool Reference

This server exposes five main tools for use by LLM agents.

### `get_fred_data`
Fetches macroeconomic data from the FRED database.

- **Parameters:**
  - `action` (string, required): `"refresh_all"` or `"get_series"`.
  - `seriesId` (string, optional): The ID of the series to fetch (e.g., `CPIAUCSL`, `UNRATE`). Required if `action` is `get_series`.
  - `startDate` / `endDate` (string, optional): Date range in `YYYY-MM-DD` format.

- **Example:**
  ```json
  {
    "tool": "get_fred_data",
    "input": { "action": "get_series", "seriesId": "GDP" }
  }
  ```

### `get_edgar_data`
Downloads official company filings from the SEC EDGAR database.

- **Parameters:**
  - `symbol` (string, required): The stock ticker symbol (e.g., `AAPL`).
  - `formTypes` (array of strings, optional): The type of forms to fetch. Defaults to `["10-K", "10-Q", "8-K"]`.

- **Example:**
  ```json
  {
    "tool": "get_edgar_data",
    "input": { "symbol": "TSLA", "formTypes": ["10-K"] }
  }
  ```

### `get_massive_data`
The primary tool for fetching comprehensive data for a specific stock from Massive.com.

- **Parameters:**
  - `symbol` (string, required): The stock ticker symbol (e.g., `MSFT`).
  - `includeChart` (boolean, optional): Include detailed chart data. Defaults to `true`.
  - `chartDays` (number, optional): The number of days of historical data for the chart. Defaults to `365`.
  - `includeEarnings` (boolean, optional): Include earnings calendar data. Defaults to `false`.
  - `includeAnalyst` (boolean, optional): Include analyst consensus data. Defaults to `false`.
  - `massiveIndicators` (array of strings, optional): A list of technical indicators to fetch directly from Massive.com. Defaults to a pre-selected list including SMA, EMA, etc.

- **Example:**
  ```json
  {
    "tool": "get_massive_data",
    "input": { "symbol": "NVDA", "massiveIndicators": ["RSI", "MACD"] }
  }
  ```

### `calculate_local_indicators`
Calculates a comprehensive set of technical indicators using the price data stored in the local database. This is useful for indicators not provided by the `get_massive_data` tool.

- **Parameters:**
  - `symbol` (string, required): The stock ticker symbol (e.g., `AAPL`).

- **Example:**
  ```json
  {
    "tool": "calculate_local_indicators",
    "input": { "symbol": "AAPL" }
  }
  ```
- **Output Snippet:**
  ```json
  "indicators": {
    "SMA": { "SMA_5": [...], "SMA_10": [...] },
    "EMA": { "EMA_5": [...], "EMA_10": [...] },
    "MACD": [ { "MACD": 5.1, "signal": 4.8, "histogram": 0.3 }, ... ],
    "RSI": [ 65.2, 66.8, ... ],
    "BollingerBands": [ { "upper": 460.1, "middle": 450.5, "lower": 440.9 }, ... ],
    "...": "and 12+ more indicators"
  }
  ```

### `get_social_sentiment`
Analyzes stock mentions and sentiment on social media platforms like Reddit and Twitter/X.

- **Parameters:**
  - `action` (string, required): The operation to perform.
    - `"get_mentions"`: Fetches the latest mentions for a single symbol.
    - `"detect_spike"`: Checks if a specific symbol is experiencing a recent spike in mentions.
    - `"detect_all_spikes"`: Checks a list of symbols for mention spikes.
    - `"detect_unknown_spikes"`: Scans recent social media activity to find symbols that are spiking without prior knowledge.
  - `symbol` (string, optional): The stock ticker symbol. Required for `get_mentions` and `detect_spike`.
  - `symbols` (array of strings, optional): A list of stock ticker symbols. Required for `detect_all_spikes`.
  - `platform` (string, optional): `"reddit"`, `"twitter"`, or `"both"`. Defaults to `reddit`.
  - `days` (number, optional): The lookback period in days for spike detection. Defaults to `7`.
  - `minSpikeRatio` (number, optional): The minimum ratio of current mentions to average mentions to be considered a spike. Defaults to `2.0`.

- **Example (Detecting a spike):**
  ```json
  {
    "tool": "get_social_sentiment",
    "input": { "action": "detect_spike", "symbol": "GME", "platform": "reddit" }
  }
  ```
- **Example (Finding unknown spikes):**
  ```json
  {
    "tool": "get_social_sentiment",
    "input": { "action": "detect_unknown_spikes", "platform": "both", "days": 3 }
  }
  ```

---

## 6. Advanced Usage

### Claude Desktop Integration
Add the server to your `%APPDATA%\Claude\claude_desktop_config.json` file:
```json
{
  "mcpServers": {
    "stocks": {
      "command": "npx.cmd",
      "args": ["tsx", "C:/path/to/your/project/stocks_mcp/src/src/server.ts"],
      "cwd": "C:/path/to/your/project/stocks_mcp/src",
      "env": { "NODE_ENV": "production" }
    }
  }
}
```
*Remember to use absolute paths.*

### Inspecting the Database
You can inspect the local SQLite database directly using the `sqlite3` CLI.
```bash
# From the src directory
sqlite3 data/stocks.sqlite "SELECT name FROM sqlite_master WHERE type='table';"
sqlite3 data/stocks.sqlite "SELECT COUNT(*) FROM price_history;"
```

### Build for Deployment
To create a production-ready JavaScript build:
```bash
# From the src directory
npm run build

# To run the built version
npm start
```

---

## 7. Troubleshooting

- **`PowerShell cannot be loaded because running scripts is disabled` error:** This is a common issue on Windows. You have two main options:
  1.  **Use Command Prompt (`cmd.exe`):** This is the simplest solution. Open `cmd.exe` and run your `npm` commands from there.
  2.  **Bypass PowerShell Policy:** You can tell PowerShell to bypass the policy for a single command. This is safe and does not permanently change your system's security settings. Prefix your command like this:
      ```powershell
      # Example for running the dev server
      powershell -ExecutionPolicy Bypass -Command "npm run dev"

      # Example for running the build script
      powershell -ExecutionPolicy Bypass -Command "npm run build"
      ```
- **`Server disconnected` in client:** Double-check that the paths in your client configuration are absolute and correct. Verify that all API keys in your `.env` file are valid.
- **No data in the database:** Data is fetched and stored only when a tool is called for the first time for a specific stock. Try calling `get_massive_data` for a symbol like `AAPL`.

---

## 8. Legal & Usage Notes

- **API Keys:** You are responsible for providing your own API keys and adhering to the terms of service of each data provider.
- **Data Redistribution:** Before redistributing data from any source (FRED, Massive.com, etc.), review their specific citation and usage policies.
- **Disclaimer:** This project is provided for research and educational purposes. It is not financial advice. For commercial deployments, consult the API terms and seek legal advice if needed.

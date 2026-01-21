# Stocks MCP Server 📈

**A powerful, all-in-one financial data server for Large Language Model (LLM) applications.**

Stocks MCP Server connects to professional-grade financial data sources, providing your AI agents and applications with the critical market insights they need. It's designed to be a seamless backend for building sophisticated financial analysis tools with LLMs like Claude, Cursor, and more.

---

## ✨ Key Features

- **Comprehensive Stock Data:** Access real-time quotes, historical prices, company reference data, options chains, and corporate actions.
- **Advanced Technical Analysis:** Fetch indicators from data providers or calculate them locally. Over 17 popular indicators are supported, including:
  - SMA, EMA, MACD, RSI, Bollinger Bands, Stochastic, Ichimoku Cloud, and more.
- **Macroeconomic Insights:** Integrate key economic indicators from the Federal Reserve (FRED), such as CPI, GDP, and unemployment rates.
- **SEC Filings:** Directly download and access official company filings (10-K, 10-Q, 8-K) from the EDGAR database.
- **Social Sentiment Analysis:** Analyze real-time market sentiment by tracking stock mentions and trends on Reddit and Twitter/X.
- **Local & Private:** All data is collected into a local SQLite database that you control, ensuring privacy and performance.

---

## 🚀 Quick Start

1.  **Install Dependencies:**
    ```bash
    # Navigate to the source directory
    cd src
    # Install required packages
    npm install
    ```

2.  **Set Up API Keys:**
    - Create a `.env` file inside the `src` directory.
    - Add your API keys for services like FRED and Massive.com. See the **[MANUAL.md](MANUAL.md)** for details.

3.  **Run the Server:**
    ```bash
    # Run the server using the dev script
    npm run dev
    ```

Your server is now running! You can connect it to any MCP-compatible client.

---

## 📖 Full Documentation

For detailed setup instructions, API key information, and a complete reference for all available tools and parameters, please see our comprehensive user manual:

➡️ **[Read the Full MANUAL.md](MANUAL.md)**

---

## ⚖️ License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Issues and pull requests are welcome! Please feel free to contribute to the project.
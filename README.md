# n8n API MCP Server

A Model Context Protocol (MCP) server designed to interact with a self-hosted n8n instance.

This server provides tools to:
- Execute calls to the n8n API.
- Search for n8n API endpoints using a local database populated from an OpenAPI specification.
- Store and retrieve frequently used or successful API calls using a "Fast Memory" database for quicker natural language access.

## Features

### Databases
- **API Specification Database (`api_spec.db`):** Stores details about n8n API endpoints, loaded from an OpenAPI/Swagger JSON file. Used by search and detail tools.
- **Fast Memory Database (`fast_memory.db`):** Caches successful API calls linked to natural language queries. Allows for quick retrieval of previously used calls and suggests saving new successful calls.

### Tools
- **`search_api_endpoints`**: Search the local API spec database for endpoints matching a query (path, summary, description, tags).
- **`get_api_endpoint_details`**: Retrieve detailed information (parameters, request body, responses) for a specific endpoint (path and method) from the local API spec database.
- **`execute_api_call`**: Execute an API call to the configured n8n instance. Checks Fast Memory first; if not found, prompts to save the call to Fast Memory upon success.
- **`natural_language_api_search`**: Search for API calls using natural language. Checks Fast Memory first, then falls back to searching the API spec database based on the query.
- **`save_to_fast_memory`**: Manually save an API call (path, method, params, data) along with its original natural language query and a description to the Fast Memory database.
- **`list_fast_memory`**: List entries currently stored in the Fast Memory database, optionally filtering by a search term.
- **`delete_from_fast_memory`**: Delete a specific entry from the Fast Memory database by its ID.
- **`clear_fast_memory`**: Remove all entries from the Fast Memory database.
- **`load_api_spec_from_json`**: Load or update the API Specification database (`api_spec.db`) by parsing an OpenAPI/Swagger JSON file.
- **`send_raw_api_request`**: Execute an API call using a raw request string (e.g., "GET /workflows?limit=5"). Uses the same underlying logic as `execute_api_call`, including Fast Memory checks and save prompts.

## Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/jasondsmith72/N8N-api-MCP.git
    cd N8N-api-MCP
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Build the server:**
    ```bash
    npm run build
    ```
    This compiles the TypeScript code to JavaScript in the `build` directory.

## Configuration

This server requires environment variables to connect to your n8n instance. These are typically set in your MCP client's configuration file (e.g., `cline_mcp_settings.json`).

- **`N8N_URL`**: The base URL of your n8n instance (e.g., `http://your-n8n.example.com`). Defaults to `http://localhost:5678` if not set.
- **`N8N_API_KEY`**: Your n8n API key for authentication.

## Loading the API Specification

Before using the search tools (`search_api_endpoints`, `natural_language_api_search`), you need to populate the API Specification database.

1.  Obtain the OpenAPI (Swagger) JSON specification file for your n8n version. This might be available from the n8n documentation or potentially downloadable from your instance (e.g., `/api/v1/docs-json`).
2.  Use the `load_api_spec_from_json` tool, providing the absolute path to the downloaded JSON file:
    ```
    load_api_spec_from_json(json_file_path="C:\\path\\to\\your\\n8n-openapi.json")
    ```

## Installation for Cline / Claude Desktop

Add the following configuration to your `cline_mcp_settings.json` (adjust the path to `index.js` based on your clone location):

```json
{
  "mcpServers": {
    "... other servers ...": {},
    "n8n-api-mcp": {
      "command": "node",
      "args": [
        "C:\\Users\\username\\OneDrive\\Documents\\Cline\\MCP\\N8N-api-MCP\\build\\index.js" // <-- Update this path if needed
      ],
      "env": {
        "N8N_URL": "YOUR_N8N_INSTANCE_URL", // e.g., "http://192.168.1.100:5678"
        "N8N_API_KEY": "YOUR_N8N_API_KEY_HERE"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```
*(Remember to replace `YOUR_N8N_INSTANCE_URL` and `YOUR_N8N_API_KEY_HERE` with your actual values)*

## Development

For development with auto-rebuild on file changes:
```bash
npm run watch
```

### Debugging

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) for easier debugging:
```bash
npm run inspector
```
The Inspector provides a web interface to view MCP communication.

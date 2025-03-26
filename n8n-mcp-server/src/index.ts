#!/usr/bin/env node

/**
 * MCP Server for interacting with an n8n instance.
 * Provides tools for searching API endpoints, executing calls,
 * and managing a 'fast memory' cache for natural language queries.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from 'axios';
import sqlite3 from 'sqlite3';
import fs from 'fs/promises'; // Use promises version of fs
import path from 'path'; // Needed for path operations
import { setupDatabases, closeDatabases } from './db/initDb.js'; // Use .js extension for ES modules

// --- Interfaces ---
// OpenAPI types (simplified)
interface OpenApiPathItem {
    summary?: string;
    description?: string;
    parameters?: any[]; // Simplified
    requestBody?: any; // Simplified
    responses?: any; // Simplified
    tags?: string[];
    // Methods like get, post, put, delete, etc.
    [method: string]: any;
}

interface OpenApiSpec {
    openapi: string;
    info: { title: string; version: string; };
    paths: { [path: string]: OpenApiPathItem };
    // components, servers, etc. - not used in this basic loader
}


interface ApiEndpoint {
    id: number;
    path: string;
    method: string;
    summary?: string;
    description?: string;
    parameters?: string; // JSON
    requestBody?: string; // JSON
    responses?: string; // JSON
    tags?: string; // JSON
}

interface FastMemoryEntry {
    id: number;
    natural_language_query: string;
    api_path: string;
    api_method: string;
    api_params?: string; // JSON
    api_data?: string; // JSON
    description?: string;
    created_at: string;
}

// --- Configuration ---
const N8N_URL = process.env.N8N_URL || 'http://localhost:5678'; // Default to localhost if not set
const N8N_API_KEY = process.env.N8N_API_KEY || 'YOUR_N8N_API_KEY'; // Placeholder

if (N8N_API_KEY === 'YOUR_N8N_API_KEY') {
    console.warn("Warning: N8N_API_KEY environment variable not set. Using placeholder.");
}

// --- Database and API Client Initialization ---
let apiSpecDb: sqlite3.Database;
let fastMemoryDb: sqlite3.Database;
let axiosInstance: AxiosInstance;

/**
 * Initializes databases and the Axios instance.
 */
async function initializeServer() {
    const dbs = await setupDatabases();
    apiSpecDb = dbs.apiSpecDb;
    fastMemoryDb = dbs.fastMemoryDb;

    axiosInstance = axios.create({
        baseURL: `${N8N_URL}/api/v1`, // Assuming v1 API, adjust if needed
        headers: {
            'Authorization': `Bearer ${N8N_API_KEY}`, // Or use 'X-N8N-API-Key' depending on n8n config
            'Content-Type': 'application/json',
        },
        timeout: 15000, // 15 second timeout
    });

    console.log(`n8n MCP Server initialized. Target URL: ${N8N_URL}`);
}

// --- MCP Server Setup ---
const server = new Server(
  {
    name: "n8n-api-mcp", // Matches folder name
    version: "0.1.0",
    description: "MCP Server for interacting with n8n API and managing fast memory.",
  },
  {
    capabilities: {
      // Resources not implemented in this version, focusing on tools
      tools: {},
    },
  }
);

// --- Tool Definitions ---
const toolDefinitions = [
    {
        name: "search_api_endpoints",
        description: "Search available n8n API endpoints stored in the local spec database.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search term for path, summary, description, or tags." },
                limit: { type: "integer", description: "Maximum number of results", default: 10 }
            },
            required: ["query"]
        }
    },
    {
        name: "get_api_endpoint_details",
        description: "Get detailed information for a specific n8n API endpoint from the local spec database.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Exact API path (e.g., /workflows)." },
                method: { type: "string", description: "HTTP method (e.g., GET, POST)." }
            },
            required: ["path", "method"]
        }
    },
    {
        name: "execute_api_call",
        description: "Execute an API call to the configured n8n instance.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "API endpoint path (e.g., /workflows)." },
                method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE, etc.)." },
                params: { type: "object", description: "Query parameters as a JSON object.", default: {} },
                data: { type: "object", description: "Request body data as a JSON object (for POST, PUT, PATCH).", default: {} }
            },
            required: ["path", "method"]
        }
    },
    {
        name: "natural_language_api_search",
        description: "Search for n8n API calls using natural language. Checks fast memory first.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Natural language description of the desired API call." },
                max_results: { type: "integer", description: "Maximum number of results (from spec DB if fast memory fails)", default: 5 }
            },
            required: ["query"]
        }
    },
    {
        name: "save_to_fast_memory",
        description: "Save a successful natural language query and its corresponding API call details to fast memory.",
        inputSchema: {
            type: "object",
            properties: {
                natural_language_query: { type: "string", description: "The original natural language query." },
                api_path: { type: "string", description: "The executed API path." },
                api_method: { type: "string", description: "The executed API method." },
                api_params: { type: "object", description: "The executed API query parameters.", default: {} },
                api_data: { type: "object", description: "The executed API request body.", default: {} },
                description: { type: "string", description: "Optional user description for this entry." }
            },
            required: ["natural_language_query", "api_path", "api_method"]
        }
    },
    {
        name: "list_fast_memory",
        description: "List entries stored in fast memory.",
        inputSchema: {
            type: "object",
            properties: {
                search_term: { type: "string", description: "Optional term to filter entries by NL query or description." },
                limit: { type: "integer", description: "Maximum number of results", default: 20 }
            },
            required: []
        }
    },
    {
        name: "delete_from_fast_memory",
        description: "Delete an entry from fast memory by its ID.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "integer", description: "The ID of the fast memory entry to delete." }
            },
            required: ["id"]
        }
    },
    {
        name: "load_api_spec_from_json",
        description: "Load n8n API specification data from a JSON file into the api_spec.db.",
        inputSchema: {
            type: "object",
            properties: {
                json_file_path: { type: "string", description: "Absolute path to the OpenAPI/Swagger JSON file." }
                // Could add options for clearing existing data, etc.
            },
            required: ["json_file_path"]
        }
    },
    {
        name: "clear_fast_memory",
        description: "Clear all entries from the fast memory database.",
        inputSchema: { type: "object", properties: {} } // No arguments needed
    },
    {
        name: "send_raw_api_request",
        description: "Send a raw API request string to the n8n API. Format: 'METHOD /path?query=val [JSON_BODY]'",
        inputSchema: {
            type: "object",
            properties: {
                raw_request: { type: "string", description: "Raw request string (e.g., 'GET /workflows?limit=5', 'POST /workflows {\"name\":\"New Workflow\"}')" }
            },
            required: ["raw_request"]
        }
    }
];

// --- State Tracking ---
// Track if the most recent execute_api_call result came from fast memory
let lastCallFromFastMemory = false;
let lastSuccessfulCallDetails: { path: string, method: string, params?: object, data?: object } | null = null;


// --- API Call Helper ---
async function makeN8nApiRequest(
    method: string,
    path: string,
    params: any = {},
    data: any = {}
): Promise<any> {
    try {
        const response = await axiosInstance.request({
            method: method.toUpperCase(),
            url: path,
            params: params,
            data: data,
        });
        logger.info(`API call ${method.toUpperCase()} ${path} successful (Status: ${response.status})`);
        return response.data;
    } catch (error: any) {
        logger.error(`API call ${method.toUpperCase()} ${path} failed:`, error);
        let errorMessage = `n8n API request failed for ${method.toUpperCase()} ${path}.`;
        let errorCode = ErrorCode.InternalError;

        if (axios.isAxiosError(error)) {
            errorMessage = `n8n API error: ${error.response?.status} ${error.response?.statusText}. Response: ${JSON.stringify(error.response?.data)}`;
            if (error.response?.status === 401 || error.response?.status === 403) {
                errorCode = ErrorCode.InvalidRequest; // Treat auth errors as invalid request from MCP perspective
                errorMessage += " Check your N8N_API_KEY.";
            } else if (error.response?.status === 404) {
                errorCode = ErrorCode.InvalidRequest; // Endpoint not found
            } else if (error.response?.status && error.response.status >= 400 && error.response.status < 500) {
                errorCode = ErrorCode.InvalidParams; // Likely bad input data/params
            }
        } else if (error.message) {
            errorMessage += ` ${error.message}`;
        }
        // Throw an MCPError that the main handler can catch
        throw new McpError(errorCode, errorMessage);
    }
}


// --- Database Helper Functions ---

// Helper to run a DB query that returns multiple rows
function dbAll(db: sqlite3.Database, sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                console.error("DB Error (all):", err.message, "SQL:", sql, "Params:", params);
                reject(new McpError(ErrorCode.InternalError, `Database query failed: ${err.message}`));
            } else {
                resolve(rows);
            }
        });
    });
}

// Helper to run a DB query that affects rows (INSERT, UPDATE, DELETE)
function dbRun(db: sqlite3.Database, sql: string, params: any[] = []): Promise<{ lastID: number, changes: number }> {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { // Use function() to access this context
            if (err) {
                console.error("DB Error (run):", err.message, "SQL:", sql, "Params:", params);
                reject(new McpError(ErrorCode.InternalError, `Database operation failed: ${err.message}`));
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
}


// --- Tool Handlers ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

// Centralized logging for tool calls
const logger = {
    info: (message: string, ...optionalParams: any[]) => console.log(`[INFO] ${message}`, ...optionalParams),
    warn: (message: string, ...optionalParams: any[]) => console.warn(`[WARN] ${message}`, ...optionalParams),
    error: (message: string, ...optionalParams: any[]) => console.error(`[ERROR] ${message}`, ...optionalParams),
};


server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.info(`Executing tool: ${name}`, args);

    // Reset state flags before handling the call
    lastCallFromFastMemory = false;
    lastSuccessfulCallDetails = null;

    try {
        switch (name) {
            case "search_api_endpoints": {
                const { query, limit = 10 } = args as { query: string, limit?: number };
                if (!query) throw new McpError(ErrorCode.InvalidParams, "Query is required.");

                const sql = `
                    SELECT id, path, method, summary, description, tags
                    FROM endpoints
                    WHERE path LIKE ? OR method LIKE ? OR summary LIKE ? OR description LIKE ? OR tags LIKE ?
                    ORDER BY path, method
                    LIMIT ?;
                `;
                const params = Array(5).fill(`%${query}%`).concat(limit);
                const rows = await dbAll(apiSpecDb, sql, params);
                return { content: [{ type: "application/json", text: JSON.stringify(rows, null, 2) }] };
            }
            case "get_api_endpoint_details": {
                const { path, method } = args as { path: string, method: string };
                if (!path || !method) throw new McpError(ErrorCode.InvalidParams, "Path and method are required.");

                const sql = `SELECT * FROM endpoints WHERE path = ? AND method = ? LIMIT 1;`;
                const rows = await dbAll(apiSpecDb, sql, [path, method.toUpperCase()]);

                if (rows.length === 0) {
                    // Use InvalidRequest when the specific endpoint details aren't found in the DB
                    throw new McpError(ErrorCode.InvalidRequest, `Endpoint details not found in database: ${method.toUpperCase()} ${path}`);
                }
                 // Parse JSON fields before returning
                const endpoint = rows[0];
                try {
                    endpoint.parameters = endpoint.parameters ? JSON.parse(endpoint.parameters) : null;
                    endpoint.requestBody = endpoint.requestBody ? JSON.parse(endpoint.requestBody) : null;
                    endpoint.responses = endpoint.responses ? JSON.parse(endpoint.responses) : null;
                    endpoint.tags = endpoint.tags ? JSON.parse(endpoint.tags) : null; // Assuming tags stored as JSON array string
                } catch (parseError: any) {
                    console.warn(`Failed to parse JSON fields for endpoint ${method} ${path}: ${parseError.message}`);
                    // Return raw strings if parsing fails
                }
                return { content: [{ type: "application/json", text: JSON.stringify(endpoint, null, 2) }] };
            }
            case "execute_api_call": {
                let { path, method, params, data } = args as { path: string, method: string, params?: object, data?: object };
                if (!path || !method) throw new McpError(ErrorCode.InvalidParams, "Path and method are required.");

                // Check Fast Memory first
                const fastMemorySql = `SELECT * FROM fast_memory WHERE path = ? AND method = ? LIMIT 1`;
                const fastResults = await dbAll(fastMemoryDb, fastMemorySql, [path, method.toUpperCase()]);

                let fastMemoryEntry: FastMemoryEntry | null = null;
                if (fastResults.length > 0) {
                    fastMemoryEntry = fastResults[0] as FastMemoryEntry;
                    logger.info(`Found matching entry in fast memory (ID: ${fastMemoryEntry.id}) for ${method} ${path}`);
                    lastCallFromFastMemory = true;
                    // Use saved params/data if not provided in the current call
                    if (!params && fastMemoryEntry.api_params) {
                        try { params = JSON.parse(fastMemoryEntry.api_params); } catch { /* ignore parse error */ }
                    }
                    if (!data && fastMemoryEntry.api_data) {
                        try { data = JSON.parse(fastMemoryEntry.api_data); } catch { /* ignore parse error */ }
                    }
                    // Increment usage count (fire and forget)
                    dbRun(fastMemoryDb, `UPDATE fast_memory SET usage_count = usage_count + 1 WHERE id = ?`, [fastMemoryEntry.id])
                        .catch(err => logger.error(`Failed to increment usage count for fast memory ID ${fastMemoryEntry?.id}: ${err.message}`));
                }

                // Execute the API call using the helper
                const result = await makeN8nApiRequest(method, path, params, data);

                // Store details for potential saving
                lastSuccessfulCallDetails = { path, method, params, data };

                // Format response and add context/save prompt
                let responseText = JSON.stringify(result, null, 2);
                let messagePrefix = "";
                let saveSuggestion = "";

                if (lastCallFromFastMemory && fastMemoryEntry) {
                    messagePrefix = `[Using query from Fast Memory: ${fastMemoryEntry.description || `ID ${fastMemoryEntry.id}`}]\n\n`;
                } else {
                    // Format save suggestion
                    const paramsStr = params ? `, params: ${JSON.stringify(params)}` : '';
                    const dataStr = data ? `, data: ${JSON.stringify(data)}` : '';
                    saveSuggestion = `\n\n---\nAPI call successful. To save this to Fast Memory for future use:\n` +
                                     `save_to_fast_memory(description="YOUR_DESCRIPTION", path="${path}", method="${method.toUpperCase()}"${paramsStr}${dataStr})`;
                }

                 // Truncate large responses
                const MAX_RESPONSE_LENGTH = 5000; // Adjust as needed
                if (responseText.length > MAX_RESPONSE_LENGTH) {
                    responseText = responseText.substring(0, MAX_RESPONSE_LENGTH) + "\n... (Response truncated)";
                }


                return { content: [{ type: "application/json", text: messagePrefix + responseText + saveSuggestion }] };
            }
            case "natural_language_api_search": {
                const { query, max_results = 5 } = args as { query: string, max_results?: number };
                if (!query) throw new McpError(ErrorCode.InvalidParams, "Query is required.");

                // 1. Check Fast Memory
                const fastMemorySql = `SELECT * FROM fast_memory WHERE natural_language_query LIKE ? LIMIT 1`;
                const fastResults = await dbAll(fastMemoryDb, fastMemorySql, [`%${query}%`]);

                if (fastResults.length > 0) {
                    const entry = fastResults[0] as FastMemoryEntry;
                    console.log(`Found match in fast memory for query: "${query}"`);
                    // Return the stored API call details
                    return {
                        content: [{
                            type: "application/json",
                            text: JSON.stringify({
                                message: "Found match in fast memory.",
                                entry: {
                                    id: entry.id,
                                    natural_language_query: entry.natural_language_query,
                                    api_path: entry.api_path,
                                    api_method: entry.api_method,
                                    api_params: entry.api_params ? JSON.parse(entry.api_params) : undefined,
                                    api_data: entry.api_data ? JSON.parse(entry.api_data) : undefined,
                                    description: entry.description,
                                    created_at: entry.created_at,
                                }
                            }, null, 2)
                        }]
                    };
                }

                // 2. If not in fast memory, search API Spec DB
                console.log(`No match in fast memory for query: "${query}". Searching API spec DB...`);
                const specSql = `
                    SELECT id, path, method, summary, description, tags
                    FROM endpoints
                    WHERE summary LIKE ? OR description LIKE ? OR path LIKE ? OR tags LIKE ?
                    ORDER BY length(summary) -- Prioritize matches in summary/desc
                    LIMIT ?;
                `;
                 // Prioritize summary/description, then path/tags
                const specParams = [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, max_results];
                const specResults = await dbAll(apiSpecDb, specSql, specParams);

                if (specResults.length === 0) {
                     return { content: [{ type: "text", text: `No match found in fast memory or API spec for query: "${query}"` }] };
                }

                return {
                    content: [{
                        type: "application/json",
                        text: JSON.stringify({
                            message: `Found potential matches in API spec database for query: "${query}"`,
                            results: specResults
                        }, null, 2)
                    }]
                };
            }
            case "save_to_fast_memory": {
                const {
                    natural_language_query,
                    api_path,
                    api_method,
                    api_params = {},
                    api_data = {},
                    description = ''
                } = args as {
                    natural_language_query: string,
                    api_path: string,
                    api_method: string,
                    api_params?: object,
                    api_data?: object,
                    description?: string
                };

                if (!natural_language_query || !api_path || !api_method) {
                    throw new McpError(ErrorCode.InvalidParams, "natural_language_query, api_path, and api_method are required.");
                }

                const sql = `
                    INSERT INTO fast_memory (natural_language_query, api_path, api_method, api_params, api_data, description)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(natural_language_query) DO UPDATE SET
                        api_path = excluded.api_path,
                        api_method = excluded.api_method,
                        api_params = excluded.api_params,
                        api_data = excluded.api_data,
                        description = excluded.description,
                        created_at = CURRENT_TIMESTAMP;
                `;
                const params = [
                    natural_language_query,
                    api_path,
                    api_method.toUpperCase(),
                    JSON.stringify(api_params),
                    JSON.stringify(api_data),
                    description
                ];

                const result = await dbRun(fastMemoryDb, sql, params);
                const message = result.changes > 0 ? `Saved/Updated fast memory entry (ID: ${result.lastID}) for query: "${natural_language_query}"` : "Failed to save to fast memory (no changes detected).";
                console.log(message);
                return { content: [{ type: "text", text: message }] };
            }
            case "list_fast_memory": {
                const { search_term, limit = 20 } = args as { search_term?: string, limit?: number };
                let sql = `SELECT id, natural_language_query, api_path, api_method, description, created_at FROM fast_memory`;
                const params: any[] = [];

                if (search_term) {
                    sql += ` WHERE natural_language_query LIKE ? OR description LIKE ?`;
                    params.push(`%${search_term}%`, `%${search_term}%`);
                }
                sql += ` ORDER BY created_at DESC LIMIT ?`;
                params.push(limit);

                const rows = await dbAll(fastMemoryDb, sql, params);
                return { content: [{ type: "application/json", text: JSON.stringify(rows, null, 2) }] };
            }
            case "delete_from_fast_memory": {
                const { id } = args as { id: number };
                if (typeof id !== 'number') throw new McpError(ErrorCode.InvalidParams, "A numeric ID is required.");

                const sql = `DELETE FROM fast_memory WHERE id = ?`;
                const result = await dbRun(fastMemoryDb, sql, [id]);

                const message = result.changes > 0 ? `Deleted fast memory entry with ID: ${id}` : `Fast memory entry with ID ${id} not found.`;
                console.log(message);
                return { content: [{ type: "text", text: message }] };
            }
            case "clear_fast_memory": {
                const sql = `DELETE FROM fast_memory;`;
                const vacuumSql = `VACUUM;`; // Clean up space after deleting
                const result = await dbRun(fastMemoryDb, sql);
                await dbRun(fastMemoryDb, vacuumSql); // Run vacuum separately
                const message = `Cleared ${result.changes} entries from fast memory.`;
                logger.info(message);
                return { content: [{ type: "text", text: message }] };
            }
            case "send_raw_api_request": {
                const { raw_request } = args as { raw_request: string };
                if (!raw_request) throw new McpError(ErrorCode.InvalidParams, "raw_request string is required.");

                // Basic parsing - assumes "METHOD /path?query=val {JSON_BODY}" or "METHOD /path"
                const parts = raw_request.trim().match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
                if (!parts) throw new McpError(ErrorCode.InvalidParams, "Invalid raw_request format. Use 'METHOD /path?query=val [JSON_BODY]'");

                const method = parts[1];
                const pathAndQuery = parts[2];
                const bodyString = parts[3];

                let path = pathAndQuery;
                let params: any = {};
                const queryIndex = pathAndQuery.indexOf('?');
                if (queryIndex !== -1) {
                    path = pathAndQuery.substring(0, queryIndex);
                    const queryString = pathAndQuery.substring(queryIndex + 1);
                    params = Object.fromEntries(new URLSearchParams(queryString));
                }

                let data: any = null;
                if (bodyString) {
                    try {
                        data = JSON.parse(bodyString);
                    } catch (e: any) {
                        throw new McpError(ErrorCode.InvalidParams, `Invalid JSON body provided: ${e.message}`);
                    }
                }

                // Use the standard execute_api_call logic (which includes fast memory check & save prompt)
                // Need to reconstruct args for the internal call
                const reconstructedArgs = { path, method, params, data };
                // Directly call the logic block for execute_api_call
                 logger.info(`Executing raw request as: ${method} ${path}`, { params, data });
                 // Re-use the execute_api_call logic by calling it directly
                 // This avoids duplicating the fast memory check and save prompt logic
                 // We pass the parsed arguments to it.
                 // Note: This assumes execute_api_call case doesn't rely on specific request context
                 // that isn't captured in args.
                 // Simulate calling the execute_api_call case:
                 const executeArgs = { path, method, params: params || undefined, data: data || undefined };
                 // Find the 'execute_api_call' case logic and execute it with executeArgs
                 // This is a bit of a workaround; ideally, the core logic would be in a separate function.
                 // For now, we'll just call makeN8nApiRequest directly and handle response formatting.

                 const result = await makeN8nApiRequest(method, path, params, data);
                 lastSuccessfulCallDetails = { path, method, params, data }; // Store for potential save

                 let responseText = JSON.stringify(result, null, 2);
                 let saveSuggestion = "";
                 // Only suggest saving if it wasn't found in fast memory (makeN8nApiRequest doesn't check)
                 // We need to explicitly check fast memory here if we want the save prompt
                 const fastMemorySql = `SELECT id FROM fast_memory WHERE path = ? AND method = ? LIMIT 1`;
                 const fastResults = await dbAll(fastMemoryDb, fastMemorySql, [path, method.toUpperCase()]);
                 if (fastResults.length === 0) {
                     const paramsStr = params ? `, params: ${JSON.stringify(params)}` : '';
                     const dataStr = data ? `, data: ${JSON.stringify(data)}` : '';
                     saveSuggestion = `\n\n---\nAPI call successful. To save this to Fast Memory for future use:\n` +
                                      `save_to_fast_memory(description="YOUR_DESCRIPTION", path="${path}", method="${method.toUpperCase()}"${paramsStr}${dataStr})`;
                 }

                 const MAX_RESPONSE_LENGTH = 5000;
                 if (responseText.length > MAX_RESPONSE_LENGTH) {
                     responseText = responseText.substring(0, MAX_RESPONSE_LENGTH) + "\n... (Response truncated)";
                 }

                 return { content: [{ type: "application/json", text: responseText + saveSuggestion }] };

            }
             case "load_api_spec_from_json": {
                 const { json_file_path } = args as { json_file_path: string };
                 if (!json_file_path) throw new McpError(ErrorCode.InvalidParams, "JSON file path is required.");

                 logger.info(`Attempting to load API spec from: ${json_file_path}`);

                 // 1. Read the JSON file
                 let specContent: string;
                 try {
                     specContent = await fs.readFile(json_file_path, 'utf-8');
                 } catch (readError: any) {
                     console.error(`Failed to read API spec file: ${readError.message}`);
                     throw new McpError(ErrorCode.InvalidParams, `Failed to read file at path: ${json_file_path}. Error: ${readError.message}`);
                 }

                 // 2. Parse the JSON
                 let spec: OpenApiSpec;
                 try {
                     spec = JSON.parse(specContent);
                     if (!spec.openapi || !spec.paths) {
                         throw new Error("Invalid OpenAPI format: Missing 'openapi' version or 'paths'.");
                     }
                     console.log(`Parsed OpenAPI spec version ${spec.openapi}, title: ${spec.info?.title}`);
                 } catch (parseError: any) {
                     console.error(`Failed to parse API spec JSON: ${parseError.message}`);
                     throw new McpError(ErrorCode.InvalidParams, `Failed to parse JSON from file: ${json_file_path}. Error: ${parseError.message}`);
                 }

                 // 3. Prepare and Insert data into DB
                 const insertSql = `
                    INSERT OR REPLACE INTO endpoints (path, method, summary, description, parameters, requestBody, responses, tags)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                 `;

                 let endpointsAdded = 0;
                 let endpointsFailed = 0;

                 // Use a transaction for bulk insert
                 await dbRun(apiSpecDb, 'BEGIN TRANSACTION;');

                 try {
                     for (const apiPath in spec.paths) {
                         const pathItem = spec.paths[apiPath];
                         for (const method in pathItem) {
                             // Filter out non-HTTP methods (like 'summary', 'description', 'parameters' at path level)
                             if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(method.toLowerCase())) {
                                 const endpointData = pathItem[method];
                                 const params = [
                                     apiPath,
                                     method.toUpperCase(),
                                     endpointData.summary || null,
                                     endpointData.description || null,
                                     endpointData.parameters ? JSON.stringify(endpointData.parameters) : null,
                                     endpointData.requestBody ? JSON.stringify(endpointData.requestBody) : null,
                                     endpointData.responses ? JSON.stringify(endpointData.responses) : null,
                                     endpointData.tags ? JSON.stringify(endpointData.tags) : null,
                                 ];
                                 try {
                                     await dbRun(apiSpecDb, insertSql, params);
                                     endpointsAdded++;
                                 } catch (insertError: any) {
                                     console.error(`Failed to insert endpoint ${method.toUpperCase()} ${apiPath}: ${insertError.message}`);
                                     endpointsFailed++;
                                 }
                             }
                         }
                     }
                     await dbRun(apiSpecDb, 'COMMIT;');
                     const message = `API Spec Load Complete. Added/Updated: ${endpointsAdded}, Failed: ${endpointsFailed}.`;
                     console.log(message);
                     return { content: [{ type: "text", text: message }] };

                 } catch (transactionError: any) {
                     console.error("Transaction failed during API spec load:", transactionError);
                     await dbRun(apiSpecDb, 'ROLLBACK;'); // Rollback on error
                     throw new McpError(ErrorCode.InternalError, `Database transaction failed during spec load: ${transactionError.message}`);
                 }
            }
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    } catch (error: any) {
        console.error(`Error executing tool '${name}':`, error);
        let errorMessage = `Error executing tool '${name}'.`;
        let errorCode = ErrorCode.InternalError;

        if (axios.isAxiosError(error)) {
            errorMessage = `n8n API error: ${error.response?.status} ${error.response?.statusText}. ${JSON.stringify(error.response?.data)}`;
            // Use InvalidRequest for both 401/403 and 404, relying on the message for details
            if (error.response?.status === 401 || error.response?.status === 403) errorCode = ErrorCode.InvalidRequest; // Or InternalError if more appropriate
            if (error.response?.status === 404) errorCode = ErrorCode.InvalidRequest;
            // Add more specific error handling based on n8n status codes if needed
        } else if (error instanceof McpError) {
            throw error; // Re-throw MCP specific errors
        } else if (error.message) {
            errorMessage += ` ${error.message}`;
        }

        // Return error as structured content
        return {
            content: [{ type: "text", text: errorMessage }],
            isError: true,
            // Consider adding error code if MCP spec supports it in CallToolResponse
        };
        // Alternatively, re-throw as McpError:
        // throw new McpError(errorCode, errorMessage);
    }
});


// --- Server Lifecycle ---

/**
 * Start the server: initialize components and connect transport.
 */
async function main() {
    try {
        await initializeServer();
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.log("n8n MCP server connected via stdio.");
    } catch (error) {
        console.error("Failed to start n8n MCP server:", error);
        process.exit(1);
    }
}

/**
 * Graceful shutdown: close database connections.
 */
async function shutdown() {
    console.log("Shutting down n8n MCP server...");
    try {
        await closeDatabases({ apiSpecDb, fastMemoryDb });
        await server.close();
        console.log("Server shut down gracefully.");
        process.exit(0);
    } catch (error) {
        console.error("Error during server shutdown:", error);
        process.exit(1);
    }
}

// Handle SIGINT (Ctrl+C) for graceful shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the server
main();

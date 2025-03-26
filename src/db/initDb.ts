import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

const dbDir = path.resolve(__dirname, '../../db'); // Store DBs in project root/db
const apiSpecDbPath = path.join(dbDir, 'api_spec.db');
const fastMemoryDbPath = path.join(dbDir, 'fast_memory.db');

// Ensure the db directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`Created database directory: ${dbDir}`);
} else {
  console.log(`Database directory already exists: ${dbDir}`);
}

const verboseSqlite3 = sqlite3.verbose();

function initializeDatabase(dbPath: string, schema: string, dbName: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new verboseSqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error(`Error opening ${dbName} database:`, err.message);
        return reject(err);
      }
      console.log(`Connected to the ${dbName} database at ${dbPath}`);
    });

    db.serialize(() => {
      db.exec(schema, (err) => {
        if (err) {
          console.error(`Error executing ${dbName} schema:`, err.message);
          // Don't reject if table already exists, but log other errors
          if (!err.message.includes('already exists')) {
             return reject(err);
          }
           console.log(`${dbName} tables likely already exist.`);
        } else {
          console.log(`${dbName} schema executed successfully or tables already exist.`);
        }
        resolve(db);
      });
    });
  });
}

const apiSpecSchema = `
CREATE TABLE IF NOT EXISTS endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  method TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  parameters TEXT, -- Store as JSON string
  requestBody TEXT, -- Store as JSON string
  responses TEXT, -- Store as JSON string
  tags TEXT, -- Store as JSON string (comma-separated or JSON array)
  UNIQUE(path, method)
);

CREATE INDEX IF NOT EXISTS idx_endpoints_path_method ON endpoints (path, method);
CREATE INDEX IF NOT EXISTS idx_endpoints_summary ON endpoints (summary);
CREATE INDEX IF NOT EXISTS idx_endpoints_tags ON endpoints (tags);
`;

const fastMemorySchema = `
CREATE TABLE IF NOT EXISTS fast_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  natural_language_query TEXT NOT NULL UNIQUE,
  api_path TEXT NOT NULL,
  api_method TEXT NOT NULL,
  api_params TEXT, -- Store as JSON string
  api_data TEXT, -- Store as JSON string
  description TEXT, -- User-provided description
  usage_count INTEGER DEFAULT 0, -- Track how often this entry is used
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fast_memory_nl_query ON fast_memory (natural_language_query);
CREATE INDEX IF NOT EXISTS idx_fast_memory_path_method ON fast_memory (api_path, api_method); -- Index for faster execute_api_call lookup
`;

export async function setupDatabases(): Promise<{ apiSpecDb: sqlite3.Database, fastMemoryDb: sqlite3.Database }> {
  console.log('Setting up databases...');
  try {
    const apiSpecDb = await initializeDatabase(apiSpecDbPath, apiSpecSchema, 'API Specification');
    const fastMemoryDb = await initializeDatabase(fastMemoryDbPath, fastMemorySchema, 'Fast Memory');
    console.log('Databases initialized successfully.');
    return { apiSpecDb, fastMemoryDb };
  } catch (error) {
    console.error('Failed to initialize databases:', error);
    process.exit(1); // Exit if databases can't be set up
  }
}

// Example function to close databases (call this on server shutdown)
export function closeDatabases(dbs: { apiSpecDb?: sqlite3.Database, fastMemoryDb?: sqlite3.Database }): Promise<void[]> {
    const promises: Promise<void>[] = [];
    if (dbs.apiSpecDb) {
        promises.push(new Promise((resolve, reject) => {
            dbs.apiSpecDb?.close((err) => {
                if (err) {
                    console.error('Error closing API Spec DB:', err.message);
                    reject(err);
                } else {
                    console.log('API Spec DB closed.');
                    resolve();
                }
            });
        }));
    }
     if (dbs.fastMemoryDb) {
        promises.push(new Promise((resolve, reject) => {
            dbs.fastMemoryDb?.close((err) => {
                if (err) {
                    console.error('Error closing Fast Memory DB:', err.message);
                    reject(err);
                } else {
                    console.log('Fast Memory DB closed.');
                    resolve();
                }
            });
        }));
    }
    return Promise.all(promises);
}

// Optional: Run setup directly if script is executed standalone
if (require.main === module) {
  setupDatabases().then(({ apiSpecDb, fastMemoryDb }) => {
    console.log('Standalone DB setup complete.');
    closeDatabases({ apiSpecDb, fastMemoryDb });
  }).catch(error => {
    console.error('Standalone DB setup failed:', error);
  });
}

import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load modes from dist directory (copied during build)
async function loadModes() {
  const modes = {};
  const modesDir = path.join(__dirname, '..', 'dist', 'modes');
  
  try {
    const entries = await fs.readdir(modesDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const mode = await loadModeFromDirectory(modesDir, entry.name);
          if (mode) {
            modes[entry.name] = mode;
          }
        } catch (error) {
          console.warn(`Failed to load mode ${entry.name}:`, error);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to load modes directory:', error);
  }
  
  return modes;
}

async function loadModeFromDirectory(modesDir, dirName) {
  const opencodeJsonPath = path.join(modesDir, dirName, 'opencode.json');
  
  try {
    const opencodeContent = await fs.readFile(opencodeJsonPath, 'utf-8');
    const config = JSON.parse(opencodeContent);
    const modeDir = path.join(modesDir, dirName);
    const dirFiles = await fs.readdir(modeDir);

    return await loadModeFromJSON(config, modeDir, dirName, dirFiles);
  } catch (error) {
    console.warn(`Failed to load mode from directory ${dirName}:`, error);
    return null;
  }
}

const titleCase = (str) =>
  str
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

async function loadModeFromJSON(config, modeDir, dirName, dirFiles) {
  const mode = {
    id: dirName,
    name: titleCase(dirName),
    author: 'OpenCode Community',
    description: '',
    votes: 0,
    downloads: 0,
    updated_at: new Date().toISOString(),
    version: '1.0.0',
    opencode_config: config,
    mode_prompt: '',
    context_instructions: []
  };

  // Load metadata
  const metadataPath = path.join(modeDir, 'metadata.json');
  try {
    const metaContent = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metaContent);
    mode.author = metadata.author || mode.author;
    mode.description = metadata.description || mode.description;
    mode.version = metadata.version || mode.version;
    mode.updated_at = metadata.date || mode.updated_at;
    if (metadata.pr_number) mode.pr_number = metadata.pr_number;
  } catch (error) {
    // metadata.json is optional
  }

  // Load mode prompt from .mode.md file
  const promptFile = dirFiles.find((f) => f.endsWith('.mode.md'));
  if (promptFile) {
    const promptPath = path.join(modeDir, promptFile);
    try {
      mode.mode_prompt = await fs.readFile(promptPath, 'utf-8');
    } catch (error) {
      console.warn(`Failed to load prompt file ${promptFile}:`, error);
    }
  }

  // Load context instructions from .instructions.md and .prompt.md files
  const instructionFiles = dirFiles.filter(
    (f) => f.endsWith('.instructions.md') || f.endsWith('.prompt.md')
  );
  
  for (const instFile of instructionFiles) {
    const contextName = instFile.endsWith('.instructions.md')
      ? instFile.replace('.instructions.md', '')
      : instFile.replace('.prompt.md', '');
    const title = titleCase(contextName);
    const instPath = path.join(modeDir, instFile);
    try {
      const content = await fs.readFile(instPath, 'utf-8');
      mode.context_instructions.push({ title, content: content.trim() });
    } catch (error) {
      console.warn(`Failed to load instruction file ${instFile}:`, error);
    }
  }

  return mode;
}

// File-based persistent storage with fallback to memory
class DataManager {
  static data = { votes: {}, downloads: {} };
  static filePaths = {
    votes: path.join('/tmp', 'openmodes-votes.json'),
    downloads: path.join('/tmp', 'openmodes-downloads.json')
  };

  static async load(type) {
    try {
      const content = await fs.readFile(DataManager.filePaths[type], 'utf-8');
      DataManager.data[type] = JSON.parse(content);
      console.log(`Loaded ${type} data from file`);
    } catch (error) {
      // File doesn't exist, try to load from environment variable as backup
      const envVar = `OPENMODES_${type.toUpperCase()}`;
      if (process.env[envVar]) {
        try {
          DataManager.data[type] = JSON.parse(process.env[envVar]);
          console.log(`Loaded ${type} data from environment`);
        } catch (e) {
          console.warn(`Failed to parse ${envVar} environment variable`);
          DataManager.data[type] = {};
        }
      } else {
        DataManager.data[type] = {};
      }
    }
  }

  static async save(type) {
    try {
      const jsonData = JSON.stringify(DataManager.data[type], null, 2);
      await fs.writeFile(DataManager.filePaths[type], jsonData);
      console.log(`Saved ${type} data to file and memory`);
    } catch (error) {
      console.error(`Failed to save ${type}:`, error);
    }
  }

  static getCount(type, modeId) {
    return DataManager.data[type]?.[modeId] || 0;
  }

  static async handleVote(modeId, direction, action, modes) {
    if (!modes[modeId]) throw new Error('Mode not found');

    if (!DataManager.data.votes[modeId]) DataManager.data.votes[modeId] = 0;

    const multiplier = direction === 'up' ? 1 : -1;
    const actionMultiplier = action === 'add' ? 1 : -1;
    DataManager.data.votes[modeId] += multiplier * actionMultiplier;

    await DataManager.save('votes');
    return { newVoteCount: DataManager.data.votes[modeId] };
  }

  static async handleDownload(modeId, modes) {
    if (!modes[modeId]) throw new Error('Mode not found');

    if (!DataManager.data.downloads[modeId]) DataManager.data.downloads[modeId] = 0;
    DataManager.data.downloads[modeId]++;

    await DataManager.save('downloads');
    return { newDownloadCount: DataManager.data.downloads[modeId] };
  }
}

// Load data on startup
await DataManager.load('votes');
await DataManager.load('downloads');

// Helper functions matching Bun server
function getModeWithVotes(modeId, modes) {
  const mode = modes[modeId];
  if (!mode) return null;

  const { name, ...modeForApi } = mode;
  return {
    ...modeForApi,
    votes: DataManager.getCount('votes', modeId),
    downloads: DataManager.getCount('downloads', modeId)
  };
}

function getAllModesWithVotes(modes) {
  const modesWithVotes = {};
  for (const [modeId, mode] of Object.entries(modes)) {
    const { name, ...modeForApi } = mode;
    modesWithVotes[modeId] = {
      ...modeForApi,
      votes: DataManager.getCount('votes', modeId),
      downloads: DataManager.getCount('downloads', modeId)
    };
  }
  return modesWithVotes;
}

function getAllModesIndex(modes) {
  const modesIndex = {};
  for (const [modeId, mode] of Object.entries(modes)) {
    const indexEntry = {
      id: modeId,
      author: mode.author,
      description: mode.description,
      votes: DataManager.getCount('votes', modeId),
      downloads: DataManager.getCount('downloads', modeId),
      updated_at: mode.updated_at,
      version: mode.version
    };

    if (mode.pr_number) {
      indexEntry.pr_number = mode.pr_number;
    }

    modesIndex[modeId] = indexEntry;
  }
  return modesIndex;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const modes = await loadModes();
    
    // Handle voting endpoint
    if (url.pathname === '/api/vote' && req.method === 'POST') {
      const { modeId, direction, action } = req.body;
      
      if (!modeId || !direction || !action) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      if (direction !== 'up' && direction !== 'down') {
        return res.status(400).json({ error: 'Invalid vote direction' });
      }
      
      if (action !== 'add' && action !== 'remove') {
        return res.status(400).json({ error: 'Invalid vote action' });
      }
      
      try {
        const result = await DataManager.handleVote(modeId, direction, action, modes);
        return res.json(result);
      } catch (error) {
        console.error('Vote error:', error);
        return res.status(500).json({ error: 'Vote failed' });
      }
    }
    
    // Handle download endpoint
    if (url.pathname === '/api/download' && req.method === 'POST') {
      const { modeId } = req.body;
      
      if (!modeId) {
        return res.status(400).json({ error: 'Missing modeId' });
      }
      
      try {
        const result = await DataManager.handleDownload(modeId, modes);
        return res.json(result);
      } catch (error) {
        console.error('Download error:', error);
        return res.status(500).json({ error: 'Download tracking failed' });
      }
    }
    
    // Handle mode files zip download
    if (url.pathname.startsWith('/api/download-zip/') && req.method === 'GET') {
      const modeId = url.pathname.split('/').pop();
      if (!modeId || !modes[modeId]) {
        return res.status(404).json({ error: 'Mode not found' });
      }

      try {
        const modesDir = path.join(__dirname, '..', 'dist', 'modes');
        const modeDir = path.join(modesDir, modeId);

        // Check if mode directory exists
        try {
          const stat = await fs.stat(modeDir);
          if (!stat.isDirectory()) {
            return res.status(404).json({ error: 'Mode directory not found' });
          }
        } catch (error) {
          return res.status(404).json({ error: 'Mode directory not found' });
        }

        // Get all files in the mode directory
        const files = await fs.readdir(modeDir);
        const zipContent = [];

        for (const fileName of files) {
          // Skip metadata.json file
          if (fileName === 'metadata.json') {
            continue;
          }

          const filePath = path.join(modeDir, fileName);
          let fileContent = await fs.readFile(filePath, 'utf-8');

          // If this is opencode.json, remove URL keys from MCP objects
          if (fileName === 'opencode.json') {
            try {
              const config = JSON.parse(fileContent);
              // Remove URL keys from MCP objects within mode configs
              if (config.mode) {
                for (const modeName in config.mode) {
                  if (config.mode[modeName].mcp) {
                    for (const mcpKey in config.mode[modeName].mcp) {
                      if (config.mode[modeName].mcp[mcpKey].url) {
                        delete config.mode[modeName].mcp[mcpKey].url;
                      }
                    }
                  }
                }
              }
              fileContent = JSON.stringify(config, null, 2);
            } catch (error) {
              console.error(`Failed to process opencode.json: ${error}`);
              // If JSON parsing fails, use original content
            }
          }

          zipContent.push({
            name: fileName,
            content: fileContent
          });
        }

        return res.json(zipContent);
      } catch (error) {
        console.error('Zip download error:', error);
        return res.status(500).json({ error: 'Failed to prepare download' });
      }
    }
    
    // Mode routes
    if (url.pathname.startsWith('/mode/')) {
      const modeId = url.pathname.split('/')[2];
      
      if (modeId === 'all') {
        return res.json(getAllModesWithVotes(modes));
      }
      
      if (modeId === 'index') {
        return res.json(getAllModesIndex(modes));
      }
      
      if (modeId) {
        const mode = getModeWithVotes(modeId, modes);
        
        if (!mode) {
          return res.status(404).json({ error: 'Mode not found' });
        }
        
        return res.json(mode);
      }
      
      return res.status(400).json({ error: 'Mode ID required' });
    }
    
    return res.status(404).json({ error: 'Not found' });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
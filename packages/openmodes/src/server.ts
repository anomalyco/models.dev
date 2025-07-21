import { getRenderWithCurrentVotes, Modes } from './render';
import path from 'path';
import { readdir, stat } from 'fs/promises';
import { Mutex } from 'async-mutex';

// Response helpers
const jsonResponse = (data: any, status = 200, indent?: number) =>
	new Response(JSON.stringify(data, null, indent), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});

const textResponse = (text: string, status = 200) =>
	new Response(text, { status });

const fileResponse = (file: any, contentType: string) =>
	new Response(file, {
		headers: { 'Content-Type': contentType }
	});

// Read HTML template
const indexHtmlPath = path.join(import.meta.dir, '..', 'index.html');
const IndexHtml = await Bun.file(indexHtmlPath).text();

class DataManager {
	private static data: Record<string, Record<string, number>> = {};
	private static mutexes: Record<string, Mutex> = {};
	private static filePaths: Record<string, string> = {};

	static initialize(type: 'votes' | 'downloads') {
		if (!DataManager.mutexes[type]) {
			DataManager.mutexes[type] = new Mutex();
			DataManager.filePaths[type] = path.join(import.meta.dir, `${type}.json`);
			DataManager.data[type] = {};
		}
	}

	static async load(type: 'votes' | 'downloads') {
		DataManager.initialize(type);
		try {
			const file = Bun.file(DataManager.filePaths[type]);
			if (await file.exists()) {
				const text = await file.text();
				DataManager.data[type] = JSON.parse(text);
			}
		} catch (error) {
			console.log(`No existing ${type} file found, starting fresh`);
		}
	}

	static getCount(type: 'votes' | 'downloads', modeId: string): number {
		return DataManager.data[type]?.[modeId] || 0;
	}

	static async handleVote(
		modeId: string,
		direction: 'up' | 'down',
		action: 'add' | 'remove'
	) {
		return await DataManager.mutexes.votes.runExclusive(async () => {
			if (!Modes[modeId]) throw new Error('Mode not found');

			if (!DataManager.data.votes[modeId]) DataManager.data.votes[modeId] = 0;

			const multiplier = direction === 'up' ? 1 : -1;
			const actionMultiplier = action === 'add' ? 1 : -1;
			DataManager.data.votes[modeId] += multiplier * actionMultiplier;

			await DataManager.save('votes');
			return { newVoteCount: DataManager.data.votes[modeId] };
		});
	}

	static async handleDownload(modeId: string) {
		return await DataManager.mutexes.downloads.runExclusive(async () => {
			if (!Modes[modeId]) throw new Error('Mode not found');

			if (!DataManager.data.downloads[modeId])
				DataManager.data.downloads[modeId] = 0;
			DataManager.data.downloads[modeId]++;

			await DataManager.save('downloads');
			return { newDownloadCount: DataManager.data.downloads[modeId] };
		});
	}

	private static async save(type: 'votes' | 'downloads') {
		try {
			await Bun.write(
				DataManager.filePaths[type],
				JSON.stringify(DataManager.data[type], null, 2)
			);
		} catch (error) {
			console.error(`Failed to save ${type}:`, error);
		}
	}
}

function getModeWithVotes(modeId: string) {
	const mode = Modes[modeId];
	if (!mode) return null;

	const { name, ...modeWithoutName } = mode;
	return {
		...modeWithoutName,
		votes: DataManager.getCount('votes', modeId),
		downloads: DataManager.getCount('downloads', modeId)
	};
}

function getAllModesWithVotes() {
	const modesWithVotes: Record<string, any> = {};
	for (const [modeId, mode] of Object.entries(Modes)) {
		const { name, ...modeWithoutName } = mode;
		modesWithVotes[modeId] = {
			...modeWithoutName,
			votes: DataManager.getCount('votes', modeId),
			downloads: DataManager.getCount('downloads', modeId)
		};
	}
	return modesWithVotes;
}

function getAllModesIndex() {
	const modesIndex: Record<string, any> = {};
	for (const [modeId, mode] of Object.entries(Modes)) {
		const indexEntry: any = {
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

await DataManager.load('votes');
await DataManager.load('downloads');

const server = Bun.serve({
	development: false,
	hostname: '0.0.0.0',
	port: 3001,
	async fetch(req) {
		const url = new URL(req.url);

		// Handle voting endpoint
		if (url.pathname === '/api/vote' && req.method === 'POST') {
			try {
				const body = await req.json();
				const { modeId, direction, action } = body;

				if (!modeId || !direction || !action) {
					return textResponse('Missing required fields', 400);
				}

				if (direction !== 'up' && direction !== 'down') {
					return textResponse('Invalid vote direction', 400);
				}

				if (action !== 'add' && action !== 'remove') {
					return textResponse('Invalid vote action', 400);
				}

				const result = await DataManager.handleVote(modeId, direction, action);
				return jsonResponse(result);
			} catch (error) {
				console.error('Vote error:', error);
				return textResponse('Vote failed', 500);
			}
		}

		// Handle download endpoint
		if (url.pathname === '/api/download' && req.method === 'POST') {
			try {
				const body = await req.json();
				const { modeId } = body;

				if (!modeId) {
					return textResponse('Missing modeId', 400);
				}

				const result = await DataManager.handleDownload(modeId);
				return jsonResponse(result);
			} catch (error) {
				console.error('Download error:', error);
				return textResponse('Download tracking failed', 500);
			}
		}

		// Handle mode files zip download
		if (url.pathname.startsWith('/api/download-zip/') && req.method === 'GET') {
			const modeId = url.pathname.split('/').pop();
			if (!modeId || !Modes[modeId]) {
				return textResponse('Mode not found', 404);
			}

			try {
				const modesDir = path.join(import.meta.dir, '..', 'modes');
				const modeDir = path.join(modesDir, modeId);

				// Check if mode directory exists
				try {
					const dirStat = await stat(modeDir);
					if (!dirStat.isDirectory()) {
						return textResponse('Mode directory not found', 404);
					}
				} catch (error) {
					return textResponse('Mode directory not found', 404);
				}

				// Get all files in the mode directory
				const files = await readdir(modeDir);
				const zipContent: Array<{ name: string; content: string }> = [];

				for (const fileName of files) {
					// Skip metadata.json file
					if (fileName === 'metadata.json') {
						continue;
					}

					const filePath = path.join(modeDir, fileName);
					let fileContent = await Bun.file(filePath).text();

					// If this is opencode.json, remove URL keys from MCP objects
					if (fileName === 'opencode.json') {
						try {
							const config = JSON.parse(fileContent);
							if (config.mcp) {
								for (const mcpKey in config.mcp) {
									if (config.mcp[mcpKey].url) {
										delete config.mcp[mcpKey].url;
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

				return jsonResponse(zipContent);
			} catch (error) {
				console.error('Zip download error:', error);
				return textResponse('Failed to prepare download', 500);
			}
		}

		if (url.pathname === '/mode/all') {
			return jsonResponse(getAllModesWithVotes(), 200, 2);
		}

		if (url.pathname === '/mode/index') {
			return jsonResponse(getAllModesIndex(), 200, 2);
		}

		if (url.pathname.startsWith('/mode/')) {
			const modeId = url.pathname.split('/')[2];
			if (!modeId) {
				return textResponse('Mode ID required', 400);
			}

			const mode = getModeWithVotes(modeId);

			if (!mode) {
				return textResponse('Mode not found', 404);
			}

			return jsonResponse(mode, 200, 2);
		}

		if (url.pathname === '/') {
			let html = IndexHtml;
			const currentRendered = getRenderWithCurrentVotes();
			html = html.replace('<!--static-->', currentRendered);
			return new Response(html, {
				headers: { 'Content-Type': 'text/html' }
			});
		}

		if (
			url.pathname.startsWith('/src/') ||
			url.pathname.startsWith('/public/')
		) {
			const filePath = path.join(import.meta.dir, '..', url.pathname);
			const file = Bun.file(filePath);
			if (await file.exists()) {
				const ext = url.pathname.split('.').pop();
				const contentTypeMap: Record<string, string> = {
					css: 'text/css',
					js: 'application/javascript',
					svg: 'image/svg+xml',
					png: 'image/png'
				};

				if (ext === 'ts') {
					const tsContent = await file.text();
					const jsContent = await Bun.build({
						entrypoints: [filePath],
						target: 'browser',
						format: 'esm'
					}).then((result) => result.outputs[0].text());

					return fileResponse(jsContent, 'application/javascript');
				}

				return fileResponse(file, contentTypeMap[ext || ''] || 'text/plain');
			}
		}

		return textResponse('Not found', 404);
	}
});

console.log(`OpenModes server running at ${server.hostname}:${server.port}`);

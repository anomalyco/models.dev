import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import apiHandler from './api/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

// Simple request body parser for JSON
async function parseBody(req) {
	return new Promise((resolve) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk.toString()));
		req.on('end', () => {
			try {
				req.body = body ? JSON.parse(body) : {};
			} catch {
				req.body = {};
			}
			resolve();
		});
	});
}

// MIME type mapping
const mimeTypes = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// Parse request body for POST requests
	if (req.method === 'POST') {
		await parseBody(req);
	}

	// Handle API routes - mimic Vercel's routing
	if (url.pathname.startsWith('/mode/') || url.pathname.startsWith('/api/')) {
		try {
			await apiHandler(req, res);
			return;
		} catch (error) {
			console.error('API Error:', error);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Internal server error' }));
			return;
		}
	}

	// Serve static files from dist directory
	let filePath = path.join(
		__dirname,
		'dist',
		url.pathname === '/' ? 'index.html' : url.pathname
	);

	try {
		const stat = fs.statSync(filePath);
		if (stat.isFile()) {
			const ext = path.extname(filePath);
			const contentType = mimeTypes[ext] || 'text/plain';

			res.writeHead(200, { 'Content-Type': contentType });
			fs.createReadStream(filePath).pipe(res);
			return;
		}
	} catch (error) {
		// File not found, serve index.html for SPA routing
		if (
			url.pathname !== '/' &&
			!url.pathname.startsWith('/api/') &&
			!url.pathname.startsWith('/mode/')
		) {
			try {
				const indexPath = path.join(__dirname, 'dist', 'index.html');
				res.writeHead(200, { 'Content-Type': 'text/html' });
				fs.createReadStream(indexPath).pipe(res);
				return;
			} catch {
				// Fall through to 404
			}
		}
	}

	// 404 Not Found
	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Not Found');
});

server.listen(PORT, () => {
	console.log(`Local Vercel-style server running at http://localhost:${PORT}`);
	console.log('API endpoints available:');
	console.log('  - http://localhost:3000/mode/index');
	console.log('  - http://localhost:3000/mode/all');
	console.log('  - http://localhost:3000/mode/archie');
});

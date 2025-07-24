#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function fetchJson(url) {
	return new Promise((resolve, reject) => {
		https
			.get(url, (res) => {
				let data = '';
				res.on('data', (chunk) => {
					data += chunk;
				});
				res.on('end', () => {
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						reject(e);
					}
				});
			})
			.on('error', reject);
	});
}

function ensureDirectoryExists(dir) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function updateOrCreateOpenCodeJson(modeData, modeId) {
	const currentDir = process.cwd();
	const openCodePath = path.join(currentDir, 'opencode.json');

	let openCodeConfig = {
		$schema: 'https://opencode.ai/config.json',
		instructions: [],
		mcp: {},
		provider: {},
		mode: {}
	};

	if (fs.existsSync(openCodePath)) {
		try {
			openCodeConfig = JSON.parse(fs.readFileSync(openCodePath, 'utf8'));
		} catch (e) {
			console.warn(
				'⚠️  Could not parse existing opencode.json, creating new one'
			);
		}
	}

	if (!openCodeConfig.mcp) openCodeConfig.mcp = {};
	if (!openCodeConfig.mode) openCodeConfig.mode = {};

	if (modeData.opencode_config && modeData.opencode_config.mode) {
		Object.entries(modeData.opencode_config.mode).forEach(([key, config]) => {
			const updatedConfig = { ...config };

			if (updatedConfig.prompt) {
				updatedConfig.prompt = `{file:./.opencode/mode/${key}/${key}.mode.md}`;
			}

			if (
				updatedConfig.instructions &&
				Array.isArray(updatedConfig.instructions)
			) {
				updatedConfig.instructions = updatedConfig.instructions.map(
					(instruction) => {
						const filename = instruction.replace('./', '');
						return `./.opencode/mode/${key}/${filename}`;
					}
				);
			}

			openCodeConfig.mode[key] = updatedConfig;
		});
	}

	fs.writeFileSync(openCodePath, JSON.stringify(openCodeConfig, null, '\t'));
}

async function installMode(modeId) {
	try {
		console.log(`📦 Installing mode: ${modeId}`);

		const url = `https://openmodes.vercel.app/mode/${modeId}`;
		const modeData = await fetchJson(url);

		// Remove URL keys from MCP configurations
		if (modeData.opencode_config && modeData.opencode_config.mode) {
			Object.values(modeData.opencode_config.mode).forEach((modeConfig) => {
				if (modeConfig.mcp) {
					Object.values(modeConfig.mcp).forEach((mcpConfig) => {
						delete mcpConfig.url;
					});
				}
			});
		}

		const currentDir = process.cwd();
		const modeDir = path.join(currentDir, '.opencode', 'mode', modeId);
		ensureDirectoryExists(modeDir);

		// Write mode files
		if (modeData.mode_prompt) {
			const promptPath = path.join(modeDir, `${modeId}.mode.md`);
			fs.writeFileSync(promptPath, modeData.mode_prompt);
		}

		if (
			modeData.context_instructions &&
			Array.isArray(modeData.context_instructions)
		) {
			modeData.context_instructions.forEach((instruction) => {
				const filename = `${instruction.title.toLowerCase()}.instructions.md`;
				const instructionPath = path.join(modeDir, filename);
				fs.writeFileSync(instructionPath, instruction.content);
			});
		}

		updateOrCreateOpenCodeJson(modeData, modeId);

		console.log(`✅ Successfully installed mode "${modeId}"`);
	} catch (error) {
		console.error(`❌ Error installing mode "${modeId}":`, error.message);
		process.exit(1);
	}
}

function removeMode(modeId) {
	try {
		console.log(`🗑️  Removing mode: ${modeId}`);

		const currentDir = process.cwd();
		const modeDir = path.join(currentDir, '.opencode', 'mode', modeId);
		const openCodePath = path.join(currentDir, 'opencode.json');

		if (fs.existsSync(modeDir)) {
			fs.rmSync(modeDir, { recursive: true, force: true });
		}

		if (fs.existsSync(openCodePath)) {
			try {
				const openCodeConfig = JSON.parse(
					fs.readFileSync(openCodePath, 'utf8')
				);

				if (openCodeConfig.mode && openCodeConfig.mode[modeId]) {
					delete openCodeConfig.mode[modeId];
					fs.writeFileSync(
						openCodePath,
						JSON.stringify(openCodeConfig, null, '\t')
					);
				}
			} catch (e) {
				console.error('⚠️  Error updating opencode.json:', e.message);
			}
		}

		console.log(`✅ Successfully removed mode "${modeId}"`);
	} catch (error) {
		console.error(`❌ Error removing mode "${modeId}":`, error.message);
		process.exit(1);
	}
}

const args = process.argv.slice(2);
const command = args[0];
const modeId = args[1];

if (command === 'install' && modeId) {
	installMode(modeId);
} else if (command === 'remove' && modeId) {
	removeMode(modeId);
} else {
	console.log('Usage: openmodes <command> <mode-id>');
	console.log('');
	console.log('Commands:');
	console.log('  install <mode-id>  Install a mode from openmodes.dev');
	console.log('  remove <mode-id>   Remove an installed mode');
	console.log('');
	console.log('Examples:');
	console.log('  npx openmodes install archie');
	console.log('  npx openmodes remove archie');
	process.exit(1);
}

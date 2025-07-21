/** @jsx jsx */
/** @jsxImportSource hono/jsx */

import { Fragment } from 'hono/jsx';
import { renderToString } from 'hono/jsx/dom/server';
import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';

// Constants
const DEFAULT_AUTHOR = 'OpenCode Community';

// String transformation utilities
const titleCase = (str: string) =>
	str
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');

interface Mode {
	id: string;
	name: string;
	author: string;
	description: string;
	votes: number;
	downloads: number;
	updated_at: string;
	version: string;
	pr_number?: number;
	opencode_config: any;
	mode_prompt: string;
	context_instructions?: Array<{ title: string; content: string }>;
}

class DataLoader {
	private static cache: Record<string, Record<string, number> | null> = {
		votes: null,
		downloads: null
	};

	private static getData(type: 'votes' | 'downloads'): Record<string, number> {
		if (DataLoader.cache[type]) return DataLoader.cache[type]!;

		try {
			const file = path.join(import.meta.dir, `${type}.json`);
			if (!existsSync(file)) return {};

			const text = readFileSync(file, 'utf-8');
			DataLoader.cache[type] = JSON.parse(text);
			return DataLoader.cache[type]!;
		} catch (error) {
			console.log(`Error loading ${type} data:`, error);
			return {};
		}
	}

	static getCurrentVotesData(): Record<string, number> {
		return DataLoader.getData('votes');
	}

	static getCurrentDownloadsData(): Record<string, number> {
		return DataLoader.getData('downloads');
	}

	static clearCache() {
		DataLoader.cache.votes = null;
		DataLoader.cache.downloads = null;
	}
}

async function loadModes(): Promise<Record<string, Mode>> {
	const modesDir = path.join(import.meta.dir, '..', 'modes');
	const entries = await readdir(modesDir, { withFileTypes: true });
	const modes: Record<string, Mode> = {};

	for (const entry of entries) {
		if (entry.isDirectory()) {
			const mode = await loadModeFromDirectory(modesDir, entry.name);
			if (mode) modes[entry.name] = mode;
		} else if (entry.name.endsWith('.json')) {
			const mode = await loadModeFromJSON(modesDir, entry.name);
			if (mode) modes[mode.id] = mode;
		}
	}

	return modes;
}

async function loadModeFromDirectory(
	modesDir: string,
	dirName: string
): Promise<Mode | null> {
	const opencodeJsonPath = path.join(modesDir, dirName, 'opencode.json');

	try {
		const opencodeContent = await readFile(opencodeJsonPath, 'utf-8');
		const opencodeData = JSON.parse(opencodeContent);
		const modeDir = path.join(modesDir, dirName);
		const dirFiles = await readdir(modeDir);

		const { systemPrompt } = await extractSystemPrompt(modeDir, dirFiles);
		const { description, author, updatedAt, version, prNumber } =
			await extractMetadata(modeDir);
		const contextInstructions = await extractContextInstructions(
			modeDir,
			dirFiles
		);

		return {
			id: dirName,
			name: titleCase(dirName),
			author,
			description,
			votes: 0,
			downloads: 0,
			updated_at: updatedAt,
			version,
			...(prNumber && { pr_number: prNumber }),
			opencode_config: opencodeData,
			mode_prompt: systemPrompt,
			context_instructions: contextInstructions
		};
	} catch (error) {
		console.log(`Skipping ${dirName}: error reading opencode.json`, error);
		return null;
	}
}

async function loadModeFromJSON(
	modesDir: string,
	fileName: string
): Promise<Mode | null> {
	try {
		const filePath = path.join(modesDir, fileName);
		const content = await readFile(filePath, 'utf-8');
		return JSON.parse(content) as Mode;
	} catch (error) {
		console.log(`Skipping ${fileName}: invalid JSON`, error);
		return null;
	}
}

async function extractSystemPrompt(modeDir: string, dirFiles: string[]) {
	const promptFile = dirFiles.find((f) => f.endsWith('.mode.md'));
	let systemPrompt = 'No system prompt found';

	if (promptFile) {
		const promptPath = path.join(modeDir, promptFile);
		systemPrompt = await readFile(promptPath, 'utf-8');
	}

	return { systemPrompt };
}

async function extractMetadata(modeDir: string) {
	let description = '';
	let author = DEFAULT_AUTHOR;
	let updatedAt = '-';
	let version = '0.1.0';
	let prNumber: number | undefined;

	try {
		const metadataPath = path.join(modeDir, 'metadata.json');
		const metaContent = await readFile(metadataPath, 'utf-8');
		const metaData = JSON.parse(metaContent);

		if (metaData.description) description = metaData.description.trim();
		if (metaData.author) author = metaData.author;
		if (metaData.date) updatedAt = metaData.date;
		if (metaData.version) version = metaData.version;
		if (metaData.pr_number) prNumber = metaData.pr_number;
	} catch {
		// Use defaults if metadata.json doesn't exist
	}

	return { description, author, updatedAt, version, prNumber };
}

async function extractContextInstructions(modeDir: string, dirFiles: string[]) {
	const instructionFiles = dirFiles.filter(
		(f) => f.endsWith('.instructions.md') || f.endsWith('.prompt.md')
	);
	const contextInstructions: Array<{ title: string; content: string }> = [];

	for (const instFile of instructionFiles) {
		const contextName = instFile.endsWith('.instructions.md')
			? instFile.replace('.instructions.md', '')
			: instFile.replace('.prompt.md', '');
		const title = titleCase(contextName);
		const instPath = path.join(modeDir, instFile);
		const content = await readFile(instPath, 'utf-8');
		contextInstructions.push({ title, content: content.trim() });
	}

	return contextInstructions;
}

export const Modes = await loadModes();

function getModesWithCurrentVotes() {
	const currentVotesData = DataLoader.getCurrentVotesData();
	const currentDownloadsData = DataLoader.getCurrentDownloadsData();

	const modesWithVotes: Record<string, any> = {};
	for (const [modeId, mode] of Object.entries(Modes)) {
		modesWithVotes[modeId] = {
			...mode,
			votes: currentVotesData[modeId] || 0,
			downloads: currentDownloadsData[modeId] || 0
		};
	}
	return modesWithVotes;
}

export function getRenderWithCurrentVotes() {
	DataLoader.clearCache();
	const ModesWithVotes = getModesWithCurrentVotes();

	return renderToString(
		<Fragment>
			<header>
				<div class='left'>
					<h1>OpenModes.dev</h1>
					<span class='slash'></span>
					<p>An open-source database of AI agent modes</p>
				</div>
				<div class='right'>
					<a
						class='github'
						target='_blank'
						rel='noopener noreferrer'
						href='https://github.com/sst/openmodes.dev'
					>
						<svg
							xmlns='http://www.w3.org/2000/svg'
							width='24'
							height='24'
							viewBox='0 0 24 24'
						>
							<path
								fill='currentColor'
								d='M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2'
							></path>
						</svg>
					</a>
					<div class='search-container'>
						<input type='text' id='search' placeholder='Search mode' />
						<span class='search-shortcut'>⌘K</span>
					</div>
					<button id='help'>How to use</button>
				</div>
			</header>
			<table class='table-modes'>
				<thead>
					<tr>
						<th class='name sortable' data-type='text'>
							Name <span class='sort-indicator'></span>
						</th>
						<th class='author sortable' data-type='text'>
							Author <span class='sort-indicator'></span>
						</th>
						<th class='description sortable' data-type='text'>
							Description <span class='sort-indicator'></span>
						</th>
						<th class='votes sortable' data-type='number'>
							Votes <span class='sort-indicator'></span>
						</th>
						<th class='downloads sortable' data-type='number'>
							Downloads <span class='sort-indicator'></span>
						</th>
						<th class='updated sortable' data-type='text'>
							Updated <span class='sort-indicator'></span>
						</th>
					</tr>
				</thead>
				<tbody>
					{Object.entries(ModesWithVotes)
						.sort(([, modeA], [, modeB]) => modeB.votes - modeA.votes)
						.map(([modeId, mode]) => (
							<tr
								key={modeId}
								class='mode-row'
								data-mode-id={modeId}
								onclick='openModeModal(this)'
							>
								<td class='name mode-name'>{mode.name}</td>
								<td class='author'>{mode.author}</td>
								<td class='description'>{mode.description}</td>
								<td class='votes'>{mode.votes}</td>
								<td class='downloads'>{mode.downloads}</td>
								<td class='updated'>{mode.updated_at}</td>
							</tr>
						))}
				</tbody>
			</table>
			<dialog id='mode-modal'>
				<div class='header'>
					<div class='header-left'>
						<div class='title-section'>
							<h2 id='modal-title'>Mode Details</h2>

							<div class='vote-section'>
								<div class='vote-group'>
									<button class='vote-btn' id='upvote-btn' onclick="vote('up')">
										<svg
											xmlns='http://www.w3.org/2000/svg'
											width='16'
											height='16'
											viewBox='0 0 24 24'
											fill='none'
											stroke='currentColor'
											stroke-width='2'
											stroke-linecap='round'
											stroke-linejoin='round'
										>
											<path d='M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3' />
										</svg>
									</button>
									<span class='vote-count' id='modal-votes'></span>
									<button
										class='vote-btn'
										id='downvote-btn'
										onclick="vote('down')"
									>
										<svg
											xmlns='http://www.w3.org/2000/svg'
											width='16'
											height='16'
											viewBox='0 0 24 24'
											fill='none'
											stroke='currentColor'
											stroke-width='2'
											stroke-linecap='round'
											stroke-linejoin='round'
										>
											<path d='M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17' />
										</svg>
									</button>
								</div>
								<div class='download-group'>
									<span class='download-count' id='modal-downloads'>
										0
									</span>
									<button
										class='download-btn'
										id='download-btn'
										onclick='downloadMode()'
									>
										<svg
											xmlns='http://www.w3.org/2000/svg'
											width='16'
											height='16'
											viewBox='0 0 24 24'
											fill='none'
											stroke='currentColor'
											stroke-width='2'
											stroke-linecap='round'
											stroke-linejoin='round'
										>
											<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' />
											<polyline points='7,10 12,15 17,10' />
											<line x1='12' y1='15' x2='12' y2='3' />
										</svg>
									</button>
								</div>
							</div>
						</div>
						<p class='author'>
							by <span id='modal-author'></span>
						</p>
					</div>
					<div class='header-right'></div>
				</div>

				<div class='body'>
					<div class='mode-content'>
						<div>
							<h4>DESCRIPTION</h4>
							<div class='description' id='modal-description'></div>
						</div>

						<div>
							<h4>MCP TOOLS</h4>
							<div class='tools-list' id='modal-tools-enabled'></div>
						</div>

						<div id='modal-tools-disabled-section' style='display: none;'>
							<h4>DISABLED TOOLS</h4>
							<div class='tools-list' id='modal-tools-disabled'></div>
						</div>

						<div>
							<h4>MODE PROMPT</h4>
							<div id='modal-system-prompt'></div>
						</div>

						<div id='context-instructions-section' style='display: none;'>
							<h4>INSTRUCTIONS</h4>
							<div
								class='context-instructions'
								id='modal-context-instructions'
							></div>
						</div>
					</div>
				</div>
			</dialog>
			<dialog id='help-modal'>
				<div class='header'>
					<h2>How to use</h2>
					<button id='close-help'>
						<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>
							<line
								x1='18'
								y1='6'
								x2='6'
								y2='18'
								stroke='currentColor'
								stroke-width='2'
								stroke-linecap='round'
							/>
							<line
								x1='6'
								y1='6'
								x2='18'
								y2='18'
								stroke='currentColor'
								stroke-width='2'
								stroke-linecap='round'
							/>
						</svg>
					</button>
				</div>
				<div class='body'>
					<p>
						<a href='/'>OpenModes</a> is a comprehensive open-source database of
						AI agent modes with tools, system prompts, and configurations.
					</p>
					<p>
						Browse through different agent modes created by the community. Each
						mode defines a specific agent behavior with its own set of tools and
						system prompt. Click on any mode to see its full details, vote on
						it, or download it for use.
					</p>
					<h2>API</h2>
					<p>You can access this data through an API.</p>
					<div class='code-block'>
						<code>
							# Get modes index (basic info only)
							<br />
							curl <a href='/mode/index'>https://openmodes.dev/mode/index</a>
							<br />
							<br />
							# Get all modes (full data)
							<br />
							curl <a href='/mode/all'>https://openmodes.dev/mode/all</a>
							<br />
							<br />
							# Get specific mode
							<br />
							curl <a href='/mode/archie'>https://openmodes.dev/mode/archie</a>
						</code>
					</div>
					<h2>Contribute</h2>
					<p>
						The data is stored on{' '}
						<a
							href='https://github.com/sst/openmodes.dev'
							target='_blank'
							rel='noopener noreferrer'
						>
							GitHub
						</a>
						.
					</p>
					<p>
						We need your help to build this database of agent modes. Feel free
						to add new modes and submit a pull request.
					</p>
				</div>
				<div class='footer'>
					<span></span>
					<a
						href='https://github.com/sst/openmodes.dev'
						target='_blank'
						rel='noopener noreferrer'
					>
						Edit on GitHub
					</a>
				</div>
			</dialog>
		</Fragment>
	);
}

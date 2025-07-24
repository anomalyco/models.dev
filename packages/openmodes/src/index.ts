// Escape HTML for safe rendering of XML/markdown tags
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Convert mode id to display name (title case)
function titleCase(str: string): string {
	return str
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

class DOMElements {
	private static _elements: any = {};
	
	static get modeModal(): HTMLDialogElement {
		return this._elements.modeModal ??= document.getElementById('mode-modal') as HTMLDialogElement;
	}
	
	static get helpModal(): HTMLDialogElement {
		return this._elements.helpModal ??= document.getElementById('help-modal') as HTMLDialogElement;
	}
	
	static get closeHelpBtn(): HTMLElement {
		return this._elements.closeHelpBtn ??= document.getElementById('close-help')!;
	}
	
	static get helpBtn(): HTMLElement {
		return this._elements.helpBtn ??= document.getElementById('help')!;
	}
	
	static get search(): HTMLInputElement {
		return this._elements.search ??= document.getElementById('search')! as HTMLInputElement;
	}
	
	static get upvoteBtn(): HTMLElement {
		return this._elements.upvoteBtn ??= document.getElementById('upvote-btn')!;
	}
	
	static get downvoteBtn(): HTMLElement {
		return this._elements.downvoteBtn ??= document.getElementById('downvote-btn')!;
	}
	
	static get downloadBtn(): HTMLElement {
		return this._elements.downloadBtn ??= document.getElementById('download-btn')!;
	}
	
	static get voteCountEl(): HTMLElement {
		return this._elements.voteCountEl ??= document.getElementById('modal-votes')!;
	}
	
	static get downloadCountEl(): HTMLElement {
		return this._elements.downloadCountEl ??= document.getElementById('modal-downloads')!;
	}
}

let currentMode: any = null;

class LocalStorage {
	static getJSON<T>(key: string, defaultValue: T): T {
		try {
			const data = localStorage.getItem(key);
			return data ? JSON.parse(data) : defaultValue;
		} catch {
			return defaultValue;
		}
	}

	static setJSON(key: string, value: any): void {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch (error) {
			console.error('Failed to save to localStorage:', error);
		}
	}
}

class UserDataManager {
	static getDownloadStatus(modeId: string): boolean {
		const downloads = LocalStorage.getJSON(
			'openmodes-downloads',
			{} as Record<string, boolean>
		);
		return downloads[modeId] || false;
	}

	static setDownloadStatus(modeId: string) {
		const downloads = LocalStorage.getJSON(
			'openmodes-downloads',
			{} as Record<string, boolean>
		);
		downloads[modeId] = true;
		LocalStorage.setJSON('openmodes-downloads', downloads);
	}

	static getVoteStatus(modeId: string): 'up' | 'down' | null {
		const votes = LocalStorage.getJSON(
			'openmodes-votes',
			{} as Record<string, 'up' | 'down'>
		);
		return votes[modeId] || null;
	}

	static setVoteStatus(modeId: string, vote: 'up' | 'down' | null) {
		const votes = LocalStorage.getJSON(
			'openmodes-votes',
			{} as Record<string, 'up' | 'down'>
		);
		if (vote === null) {
			delete votes[modeId];
		} else {
			votes[modeId] = vote;
		}
		LocalStorage.setJSON('openmodes-votes', votes);
	}
}

class URLManager {
	static getQueryParams() {
		return new URLSearchParams(window.location.search);
	}

	static updateQueryParams(updates: Record<string, string | null>) {
		const params = URLManager.getQueryParams();
		for (const [key, value] of Object.entries(updates)) {
			if (value) {
				params.set(key, value);
			} else {
				params.delete(key);
			}
		}
		const newPath = params.toString()
			? `${window.location.pathname}?${params.toString()}`
			: window.location.pathname;
		window.history.pushState({}, '', newPath);
	}

	static getColumnNameForURL(headerEl: Element): string {
		const text = headerEl.textContent?.trim().toLowerCase() || '';
		return text.replace(/↑|↓/g, '').trim().split(/\s+/).slice(0, 2).join('-');
	}

	static getColumnIndexByUrlName(name: string): number {
		const headers = document.querySelectorAll('th.sortable');
		return Array.from(headers).findIndex(
			(header) => URLManager.getColumnNameForURL(header) === name
		);
	}
}

class ModalManager {
	static helpModalScrollY = 0;

	static openHelp() {
		ModalManager.helpModalScrollY = window.scrollY;
		document.body.style.position = 'fixed';
		document.body.style.top = `-${ModalManager.helpModalScrollY}px`;
		DOMElements.helpModal.showModal();
	}

	static closeHelp() {
		DOMElements.helpModal.close();
		document.body.style.position = '';
		document.body.style.top = '';
		window.scrollTo(0, ModalManager.helpModalScrollY);
	}

	static closeMode() {
		DOMElements.modeModal.close();
		document.body.style.position = '';
		document.body.style.top = '';
		window.scrollTo(0, ModalManager.helpModalScrollY);
		currentMode = null;
	}
}

class TableManager {
	static currentSort = { column: -1, direction: 'asc' as 'asc' | 'desc' };

	static sort(column: number, direction: 'asc' | 'desc') {
		const header = document.querySelectorAll('th.sortable')[column];
		const columnType = header.getAttribute('data-type');
		if (!columnType) return;

		TableManager.currentSort = { column, direction };
		URLManager.updateQueryParams({
			sort: URLManager.getColumnNameForURL(header),
			order: direction
		});

		const tbody = document.querySelector('table tbody')!;
		const rows = Array.from(
			tbody.querySelectorAll('tr')
		) as HTMLTableRowElement[];

		rows.sort((a, b) => {
			const aValue = TableManager.getCellValue(a.cells[column], columnType);
			const bValue = TableManager.getCellValue(b.cells[column], columnType);

			if (aValue === undefined && bValue === undefined) return 0;
			if (aValue === undefined) return 1;
			if (bValue === undefined) return -1;

			let comparison = 0;
			if (columnType === 'number' || columnType === 'tools') {
				comparison = (aValue as number) - (bValue as number);
			} else {
				comparison = (aValue as string).localeCompare(bValue as string);
			}

			return direction === 'asc' ? comparison : -comparison;
		});

		rows.forEach((row) => tbody.appendChild(row));
		TableManager.updateSortIndicators(column, direction);
	}

	static getCellValue(
		cell: HTMLTableCellElement,
		type: string
	): string | number | undefined {
		const text = cell.textContent?.trim() || '';
		if (text === '-') return;
		if (type === 'number') return parseFloat(text.replace(/[$,]/g, '')) || 0;
		return text;
	}

	static updateSortIndicators(activeColumn: number, direction: 'asc' | 'desc') {
		const headers = document.querySelectorAll('th.sortable');
		headers.forEach((header, i) => {
			const indicator = header.querySelector('.sort-indicator')!;
			indicator.textContent =
				i === activeColumn ? (direction === 'asc' ? '↑' : '↓') : '';
		});
	}

	static filter(value: string) {
		const lowerCaseValue = value.toLowerCase();
		const rows = document.querySelectorAll(
			'table tbody tr'
		) as NodeListOf<HTMLTableRowElement>;

		rows.forEach((row) => {
			const cellTexts = Array.from(row.cells).map((cell) =>
				cell.textContent!.toLowerCase()
			);
			const isVisible = cellTexts.some((text) => text.includes(lowerCaseValue));
			row.style.display = isVisible ? '' : 'none';
		});

		URLManager.updateQueryParams({ search: value || null });
	}
}

async function openModeModal(row: HTMLTableRowElement) {
	const modeId = row.getAttribute('data-mode-id');
	if (!modeId) return;

	try {
		const response = await fetch(`/mode/${modeId}`);
		const mode = await response.json();
		currentMode = mode;

		populateModalContent(mode);
		updateVoteButtons(modeId);
		updateDownloadButton(modeId);

		ModalManager.helpModalScrollY = window.scrollY;
		document.body.style.position = 'fixed';
		document.body.style.top = `-${ModalManager.helpModalScrollY}px`;
		DOMElements.modeModal.showModal();
	} catch (error) {
		console.error('Failed to load mode data:', error);
	}
}

function populateModalContent(mode: any) {
	const modalElements = {
		title: document.getElementById('modal-title')!,
		author: document.getElementById('modal-author')!,
		description: document.getElementById('modal-description')!,
		systemPrompt: document.getElementById('modal-system-prompt')!
	};

	modalElements.title.textContent = titleCase(mode.id);
	modalElements.author.textContent = mode.author;
	modalElements.description.textContent = mode.description;
	DOMElements.voteCountEl.textContent = mode.votes.toString();
	DOMElements.downloadCountEl.textContent = mode.downloads.toString();

	modalElements.systemPrompt.innerHTML = `<div class="context-instruction">
  <button class="context-badge copy-badge" type="button" title="Click to copy" tabindex="0">${
		mode.prompt_file_name || 'PROMPT'
	}</button>
  <div class="context-content">${escapeHtml(mode.mode_prompt)}</div></div>`;

	populateContextInstructions(mode);
	populateTools(mode);
}

function populateContextInstructions(mode: any) {
	const section = document.getElementById('context-instructions-section')!;
	const container = document.getElementById('modal-context-instructions')!;

	if (mode.context_instructions?.length > 0) {
		section.style.display = 'block';
		container.innerHTML = mode.context_instructions
			.map(
				(instruction: any) =>
					`<div class="context-instruction">
          <button class="context-badge copy-badge" type="button" title="Click to copy" tabindex="0">${
						instruction.title
					}</button>
          <div class="context-content">${escapeHtml(
						instruction.content
					)}</div>        </div>`
			)
			.join('');
	} else {
		section.style.display = 'none';
	}
}

function populateTools(mode: any) {
	const toolElements = {
		enabledContainer: document.getElementById('modal-tools-enabled')!,
		disabledContainer: document.getElementById('modal-tools-disabled')!,
		disabledSection: document.getElementById('modal-tools-disabled-section')!
	};

	// Parse tools from opencode_config
	const enabledTools: Array<{ name: string; url?: string }> = [];
	const disabledTools: string[] = [];

	// Get MCP tools from the mode-specific config
	if (mode.opencode_config?.mode) {
		const firstModeKey = Object.keys(mode.opencode_config.mode)[0];
		if (firstModeKey && mode.opencode_config.mode[firstModeKey].mcp) {
			Object.entries(mode.opencode_config.mode[firstModeKey].mcp).forEach(
				([key, value]: [string, any]) => {
					if (value.enabled !== false) {
						enabledTools.push({ name: key, url: value.url || undefined });
					}
				}
			);
		}
	}

	if (mode.opencode_config?.mode) {
		const firstModeKey = Object.keys(mode.opencode_config.mode)[0];
		if (firstModeKey && mode.opencode_config.mode[firstModeKey].tools) {
			Object.entries(mode.opencode_config.mode[firstModeKey].tools).forEach(
				([tool, enabled]) => {
					if (enabled === false) disabledTools.push(tool);
				}
			);
		}
	}

	let enabledToolsHtml = '';
	if (enabledTools.length > 0) {
		enabledToolsHtml = enabledTools
			.map((tool) => {
				const toolName = typeof tool === 'string' ? tool : tool.name;
				const toolUrl = typeof tool === 'object' && tool.url ? tool.url : null;
				return toolUrl
					? `<a href="${toolUrl}" target="_blank" rel="noopener noreferrer" class="tool-tag tool-enabled">${toolName}</a>`
					: `<span class="tool-tag tool-enabled">${toolName}</span>`;
			})
			.join('');
	}
	toolElements.enabledContainer.innerHTML = enabledToolsHtml;

	if (disabledTools.length > 0) {
		toolElements.disabledSection.style.display = 'block';
		toolElements.disabledContainer.innerHTML = disabledTools
			.map(
				(tool: string) => `<span class="tool-tag tool-disabled">${tool}</span>`
			)
			.join('');
	} else {
		toolElements.disabledSection.style.display = 'none';
	}
}

function updateVoteButtons(modeId: string) {
	const userVote = UserDataManager.getVoteStatus(modeId);

	DOMElements.upvoteBtn.classList.remove('disabled', 'voted');
	DOMElements.downvoteBtn.classList.remove('disabled', 'voted');
	DOMElements.upvoteBtn.removeAttribute('disabled');
	DOMElements.downvoteBtn.removeAttribute('disabled');

	if (userVote === 'up') {
		DOMElements.upvoteBtn.classList.add('voted');
	} else if (userVote === 'down') {
		DOMElements.downvoteBtn.classList.add('voted');
	}
}

function updateDownloadButton(modeId: string) {
	const hasDownloaded = UserDataManager.getDownloadStatus(modeId);
	DOMElements.downloadBtn.classList.toggle('downloaded', hasDownloaded);
}

async function vote(direction: 'up' | 'down') {
	if (!currentMode) return;

	const modeId = currentMode.id;
	const currentVote = UserDataManager.getVoteStatus(modeId);

	const { newVote, apiCalls } = calculateVoteChanges(currentVote, direction);

	UserDataManager.setVoteStatus(modeId, newVote);
	updateVoteUI(newVote);
	setButtonsDisabled(true);

	try {
		for (const call of apiCalls) {
			const response = await fetch('/api/vote', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					modeId,
					direction: call.direction,
					action: call.action
				})
			});

			if (!response.ok) throw new Error(`Vote failed: ${response.statusText}`);

			if (call === apiCalls[apiCalls.length - 1]) {
				const result = await response.json();
				updateCountUI('votes', result.newVoteCount, modeId);
			}
		}
	} catch (error) {
		console.error('Failed to vote:', error);
		UserDataManager.setVoteStatus(modeId, currentVote);
		updateVoteUI(currentVote);
	} finally {
		setButtonsDisabled(false);
	}
}

function calculateVoteChanges(
	currentVote: 'up' | 'down' | null,
	direction: 'up' | 'down'
) {
	let newVote: 'up' | 'down' | null;
	const apiCalls: Array<{
		direction: 'up' | 'down';
		action: 'add' | 'remove';
	}> = [];

	if (currentVote === direction) {
		newVote = null;
		apiCalls.push({ direction, action: 'remove' });
	} else if (currentVote === null) {
		newVote = direction;
		apiCalls.push({ direction, action: 'add' });
	} else {
		newVote = direction;
		apiCalls.push({ direction: currentVote, action: 'remove' });
		apiCalls.push({ direction, action: 'add' });
	}

	return { newVote, apiCalls };
}

function updateVoteUI(vote: 'up' | 'down' | null) {
	DOMElements.upvoteBtn.classList.toggle('voted', vote === 'up');
	DOMElements.downvoteBtn.classList.toggle('voted', vote === 'down');
}

function setButtonsDisabled(disabled: boolean) {
	if (disabled) {
		DOMElements.upvoteBtn.setAttribute('disabled', 'true');
		DOMElements.downvoteBtn.setAttribute('disabled', 'true');
	} else {
		DOMElements.upvoteBtn.removeAttribute('disabled');
		DOMElements.downvoteBtn.removeAttribute('disabled');
	}
}

function updateCountUI(
	type: 'votes' | 'downloads',
	newCount: number,
	modeId: string
) {
	if (!currentMode) return;
	currentMode[type] = newCount;
	const modalCountEl =
		type === 'votes' ? DOMElements.voteCountEl : DOMElements.downloadCountEl;
	modalCountEl.textContent = newCount.toString();
	const tableRow = document.querySelector(`tr[data-mode-id="${modeId}"]`);
	const cellClass = type;
	const cell = tableRow?.querySelector(`.${cellClass}`);
	if (cell) cell.textContent = newCount.toString();
}

async function downloadMode() {
	if (!currentMode) return;

	const modeId = currentMode.id;
	const hasDownloaded = UserDataManager.getDownloadStatus(modeId);

	try {
		const response = await fetch(`/api/download-zip/${modeId}`);
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to fetch mode files: ${response.status} ${errorText}`
			);
		}

		const files = await response.json();
		const zip = new (window as any).JSZip();
		files.forEach((file: { name: string; content: string }) => {
			zip.file(file.name, file.content);
		});

		const zipBlob = await zip.generateAsync({ type: 'blob' });
		downloadFile(zipBlob, `${modeId}.zip`);

		if (!hasDownloaded) {
			await updateDownloadCount(modeId);
		}
	} catch (error) {
		console.error('Failed to download mode:', error);
		alert('Failed to download mode files. Please try again.');
	}
}

function downloadFile(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

async function updateDownloadCount(modeId: string) {
	try {
		const countResponse = await fetch('/api/download', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ modeId })
		});

		if (countResponse.ok) {
			const result = await countResponse.json();
			updateCountUI('downloads', result.newDownloadCount, modeId);
			UserDataManager.setDownloadStatus(modeId);
			DOMElements.downloadBtn.classList.add('downloaded');
		}
	} catch (error) {
		console.error('Failed to track download:', error);
	}
}

function initializeFromURL() {
	const params = URLManager.getQueryParams();

	const searchQuery = params.get('search');
	if (searchQuery) {
		DOMElements.search.value = searchQuery;
		TableManager.filter(searchQuery);
	}

	const columnName = params.get('sort');
	if (columnName) {
		const columnIndex = URLManager.getColumnIndexByUrlName(columnName);
		if (columnIndex !== -1) {
			const direction = (params.get('order') as 'asc' | 'desc') || 'asc';
			TableManager.sort(columnIndex, direction);
		}
	}
}

function setupEventListeners() {
	// Check if this is a static site without server-rendered content
	const modeModal = document.getElementById('mode-modal');
	const helpModal = document.getElementById('help-modal');
	
	if (!modeModal || !helpModal) {
		console.warn('App appears to be running in static mode without server-rendered content');
		return;
	}

	// Add click-to-copy for all context badges in modal
	DOMElements.modeModal.addEventListener('click', function (e) {
		const target = e.target as HTMLElement;
		if (target && target.classList.contains('copy-badge')) {
			const contextInstruction = target.closest('.context-instruction');
			if (!contextInstruction) return;
			const codeBlock = contextInstruction.querySelector('context-content');
			if (!codeBlock) return;
			const text = codeBlock.textContent || '';
			if (!navigator.clipboard) {
				// fallback for older browsers
				const textarea = document.createElement('textarea');
				textarea.value = text;
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
			} else {
				navigator.clipboard.writeText(text);
			}
			// Visual feedback
			target.classList.add('copied');
			const original = target.textContent;
			target.textContent = 'Copied!';
			setTimeout(() => {
				target.classList.remove('copied');
				target.textContent = original;
			}, 1200);
		}
	});

	DOMElements.helpBtn.addEventListener('click', ModalManager.openHelp);
	DOMElements.closeHelpBtn.addEventListener('click', ModalManager.closeHelp);
	DOMElements.helpModal.addEventListener('cancel', ModalManager.closeHelp);
	DOMElements.helpModal.addEventListener('click', (e) => {
		if (e.target === DOMElements.helpModal) ModalManager.closeHelp();
	});

	DOMElements.modeModal.addEventListener('cancel', ModalManager.closeMode);
	DOMElements.modeModal.addEventListener('click', (e) => {
		if (e.target === DOMElements.modeModal) ModalManager.closeMode();
	});

	document.querySelectorAll('th.sortable').forEach((header) => {
		header.addEventListener('click', () => {
			const column = Array.from(header.parentElement!.children).indexOf(header);
			const direction =
				TableManager.currentSort.column === column &&
				TableManager.currentSort.direction === 'asc'
					? 'desc'
					: 'asc';
			TableManager.sort(column, direction);
		});
	});

	DOMElements.search.addEventListener('input', () => {
		TableManager.filter(DOMElements.search.value);
	});

	document.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			DOMElements.search.focus();
		}
		if (e.key === 'Escape' && DOMElements.modeModal.open) {
			ModalManager.closeMode();
		}
	});

	DOMElements.search.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			DOMElements.search.value = '';
			DOMElements.search.dispatchEvent(new Event('input'));
		}
	});
}

// Load current vote/download data and update table
async function updateTableCounts() {
	// First, set all counts to "-" while loading
	const rows = document.querySelectorAll('.mode-row');
	rows.forEach((row: Element) => {
		const votesCell = row.querySelector('.votes');
		const downloadsCell = row.querySelector('.downloads');
		if (votesCell) votesCell.textContent = '-';
		if (downloadsCell) downloadsCell.textContent = '-';
	});

	try {
		const response = await fetch('/mode/index');
		if (!response.ok) return;
		
		const modesIndex = await response.json();
		
		// Update each table row with current counts
		rows.forEach((row: Element) => {
			const modeId = (row as HTMLElement).dataset.modeId;
			if (modeId && modesIndex[modeId]) {
				const mode = modesIndex[modeId];
				
				// Update votes
				const votesCell = row.querySelector('.votes');
				if (votesCell) votesCell.textContent = mode.votes.toString();
				
				// Update downloads  
				const downloadsCell = row.querySelector('.downloads');
				if (downloadsCell) downloadsCell.textContent = mode.downloads.toString();
			}
		});
	} catch (error) {
		console.warn('Failed to update table counts:', error);
		// On error, revert to showing 0s
		rows.forEach((row: Element) => {
			const votesCell = row.querySelector('.votes');
			const downloadsCell = row.querySelector('.downloads');
			if (votesCell && votesCell.textContent === '-') votesCell.textContent = '0';
			if (downloadsCell && downloadsCell.textContent === '-') downloadsCell.textContent = '0';
		});
	}
}

(window as any).openModeModal = openModeModal;
(window as any).vote = vote;
(window as any).downloadMode = downloadMode;

document.addEventListener('DOMContentLoaded', () => {
	setupEventListeners();
	initializeFromURL();
	updateTableCounts(); // Load current vote/download data
});
window.addEventListener('popstate', initializeFromURL);

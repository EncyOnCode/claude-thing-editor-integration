// Client for the figma-sync command channel exposed by thing-editor's
// command-watcher.js. Writes <project>/.thing-editor-meta/.command.json with
// a payload, polls for <project>/.thing-editor-meta/.status.json with a
// matching commandId, returns the parsed status (or throws on timeout /
// failure).
//
// The channel is editor-running only; if no editor is open against the
// project, the command file will just sit on disk. Honest timeout reporting
// surfaces that case.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const META_DIR = '.thing-editor-meta';
const COMMAND_FILE = '.command.json';
const STATUS_FILE = '.status.json';
const POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

function metaPaths(projectRoot) {
	const root = resolve(projectRoot);
	const dir = join(root, META_DIR);
	return {
		dir,
		commandPath: join(dir, COMMAND_FILE),
		statusPath: join(dir, STATUS_FILE)
	};
}

function atomicWrite(filePath, payload) {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmp = filePath + '.tmp-' + Math.random().toString(36).slice(2);
	writeFileSync(tmp, JSON.stringify(payload, null, '\t'));
	renameSync(tmp, filePath);
}

function readJsonIfExists(filePath) {
	if (!existsSync(filePath)) return null;
	try {
		const content = readFileSync(filePath, 'utf8');
		if (!content.trim()) return null;
		return JSON.parse(content);
	} catch {
		return null;
	}
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

export async function sendCommand(projectRoot, payload, opts = {}) {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, onPoll } = opts;
	const { commandPath, statusPath } = metaPaths(projectRoot);
	const commandId = payload.id ?? randomUUID();
	const fullPayload = { ...payload, id: commandId };

	// Clear any prior status that would otherwise satisfy us instantly.
	if (existsSync(statusPath)) {
		try { unlinkSync(statusPath); } catch { /* ignore */ }
	}

	atomicWrite(commandPath, fullPayload);

	const start = Date.now();
	let pollCount = 0;
	while (Date.now() - start < timeoutMs) {
		await sleep(POLL_INTERVAL_MS);
		pollCount++;
		const status = readJsonIfExists(statusPath);
		if (status && status.commandId === commandId && (status.status === 'completed' || status.status === 'failed')) {
			if (onPoll) onPoll({ status, pollCount, elapsedMs: Date.now() - start });
			return status;
		}
		if (onPoll && pollCount % 10 === 0) {
			onPoll({ status: null, pollCount, elapsedMs: Date.now() - start });
		}
	}

	throw new Error(`figma-sync command ${commandId} (${payload.cmd}) timed out after ${timeoutMs}ms — is the editor open on ${projectRoot}?`);
}

export async function exportSceneViaCommand(projectRoot, sceneName, opts = {}) {
	const status = await sendCommand(projectRoot, {
		cmd: 'export-scene',
		name: sceneName,
		forceDiscard: !!opts.forceDiscard
	}, opts);
	if (status.status !== 'completed') {
		throw new Error(`export-scene ${sceneName} failed: ${status.error || 'unknown'}`);
	}
	return status.result;
}

export async function exportAllScenesViaCommand(projectRoot, opts = {}) {
	const status = await sendCommand(projectRoot, {
		cmd: 'export-all',
		forceDiscard: !!opts.forceDiscard
	}, opts);
	if (status.status !== 'completed') {
		throw new Error(`export-all failed: ${status.error || 'unknown'}`);
	}
	return status.result;
}

export async function openSceneViaCommand(projectRoot, sceneName, opts = {}) {
	const status = await sendCommand(projectRoot, {
		cmd: 'open-scene',
		name: sceneName,
		forceDiscard: !!opts.forceDiscard
	}, opts);
	if (status.status !== 'completed') {
		throw new Error(`open-scene ${sceneName} failed: ${status.error || 'unknown'}`);
	}
	return status.result;
}

// CLI: quick manual smoke test.
// Usage: node command-client.mjs <project-root> <cmd> [scene-name]
if (import.meta.url === `file://${process.argv[1]}`) {
	const [, , projectRoot, cmd, name] = process.argv;
	if (!projectRoot || !cmd) {
		console.error('usage: command-client.mjs <project-root> <export-scene|export-all|open-scene> [scene-name]');
		process.exit(2);
	}
	try {
		let res;
		if (cmd === 'export-scene') res = await exportSceneViaCommand(projectRoot, name, { onPoll: (s) => process.stderr.write('.') });
		else if (cmd === 'export-all') res = await exportAllScenesViaCommand(projectRoot, { onPoll: () => process.stderr.write('.') });
		else if (cmd === 'open-scene') res = await openSceneViaCommand(projectRoot, name, { onPoll: () => process.stderr.write('.') });
		else throw new Error('unknown cmd: ' + cmd);
		process.stderr.write('\n');
		console.log(JSON.stringify(res, null, 2));
	} catch (e) {
		console.error('FAIL:', e.message);
		process.exit(1);
	}
}

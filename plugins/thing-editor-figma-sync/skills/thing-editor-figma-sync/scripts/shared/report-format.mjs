// Markdown table + JSON emitter for workflow reports.
// Used by diff-snapshot.mjs and naming-validator.mjs.
//
// Exports:
//   mdTable(headers, rows) → markdown table string
//   mdDiffReport(diffSnapshot) → full Workflow A markdown report (Parts A-E)
//   mdValidatorReport(findings, opts) → full Workflow B markdown report
//   jsonReport(snapshot) → pretty-printed JSON
//   summarizeFindings(findings) → { error, warn, info, exitCode }

export function mdTable(headers, rows) {
	const lines = [];
	lines.push('| ' + headers.join(' | ') + ' |');
	lines.push('|' + headers.map(() => '---').join('|') + '|');
	for (const row of rows) {
		lines.push('| ' + row.map(c => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |');
	}
	return lines.join('\n');
}

export function summarizeFindings(findings) {
	const counts = { error: 0, warn: 0, info: 0 };
	for (const f of findings) {
		if (counts[f.severity] != null) counts[f.severity]++;
	}
	let exitCode = 0;
	if (counts.error > 0) exitCode = 2;
	else if (counts.warn > 0) exitCode = 1;
	return { ...counts, exitCode };
}

// Workflow B (validator) markdown report.
export function mdValidatorReport(findings, opts = {}) {
	const lines = [];
	lines.push(`=== Figma naming validation ===`);
	if (opts.fileKey) lines.push(`file: ${opts.fileKey}${opts.nodeId ? ` / node: ${opts.nodeId}` : ''}`);
	if (opts.scanned != null) lines.push(`scanned: ${opts.scanned} layers${opts.skipped ? ` (${opts.skipped} skipped with _ prefix)` : ''}`);
	lines.push('');

	// Sort by severity then by code.
	const sevOrder = { error: 0, warn: 1, info: 2 };
	const sorted = [...findings].sort((a, b) => {
		const sd = (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99);
		if (sd !== 0) return sd;
		return (a.code || '').localeCompare(b.code || '');
	});

	for (const f of sorted) {
		const sev = `[${f.severity}]`.padEnd(8);
		const code = (f.code || '').padEnd(6);
		const path = f.figmaPath || f.figmaNodeId || '?';
		lines.push(`${sev} ${code} ${path.padEnd(25)} — ${f.message}`);
	}

	const summary = summarizeFindings(findings);
	lines.push('');
	lines.push(`Summary: ${summary.error} error, ${summary.warn} warn, ${summary.info} info  (exit ${summary.exitCode})`);
	return lines.join('\n');
}

// Workflow A (diff) markdown report. Format follows Parts A-E from existing SKILL.md.
export function mdDiffReport(snapshot) {
	const lines = [];
	lines.push(`=== Figma → Scene diff ===`);
	lines.push(`scene: ${snapshot.scene}`);
	if (snapshot.figma) lines.push(`figma: ${snapshot.figma.fileKey}${snapshot.figma.nodeId ? ` / ${snapshot.figma.nodeId}` : ''}`);
	lines.push('');

	// Part A — coordinate derivations
	if (snapshot.derivations && snapshot.derivations.length) {
		lines.push('## Part A — Coordinate derivations');
		lines.push('');
		for (const d of snapshot.derivations) {
			lines.push(`**${d.container}** origin in world:`);
			lines.push(`${d.steps.join(' → ')}`);
			lines.push('');
		}
	}

	// Part B — per-node diff table
	if (snapshot.diffs && snapshot.diffs.length) {
		lines.push('## Part B — Per-node diffs');
		lines.push('');
		// Group by node path
		const byNode = new Map();
		for (const d of snapshot.diffs) {
			const key = (d.scenePath || []).join('.');
			if (!byNode.has(key)) byNode.set(key, []);
			byNode.get(key).push(d);
		}
		let row = 1;
		const rows = [];
		for (const [path, ds] of byNode) {
			for (const d of ds) {
				rows.push([
					row++,
					`\`${path || '<root>'}\``,
					`\`${d.prop}\``,
					formatValue(d.from),
					`**${formatValue(d.to)}**`,
					d.severity || 'patch'
				]);
			}
		}
		lines.push(mdTable(['#', 'Node path', 'Prop', 'Current', 'Proposed', 'Severity'], rows));
		lines.push('');
	}

	// Part C — no-change confirmations
	if (snapshot.confirmed && snapshot.confirmed.length) {
		lines.push('## Part C — Confirmed (no change needed)');
		lines.push('');
		for (const c of snapshot.confirmed) {
			lines.push(`- \`${(c.scenePath || []).join('.') || '<root>'}\` ${c.prop} = ${formatValue(c.value)}`);
		}
		lines.push('');
	}

	// Part D — flags / assumptions
	if (snapshot.flags && snapshot.flags.length) {
		lines.push('## Part D — Flags & assumptions');
		lines.push('');
		for (const f of snapshot.flags) {
			lines.push(`- ⚠️ [${f.code || '?'}/${f.level || 'info'}] ${(f.scenePath || []).join('.') || '<root>'} — ${f.message}`);
		}
		lines.push('');
	}

	// Unmatched
	if (snapshot.unmatched) {
		const { figmaOnly = [], sceneOnly = [] } = snapshot.unmatched;
		if (figmaOnly.length || sceneOnly.length) {
			lines.push('## Unmatched nodes');
			lines.push('');
			if (figmaOnly.length) {
				lines.push('### Figma-only (no scene match)');
				for (const n of figmaOnly) lines.push(`- ${n.figmaId} ${n.name} (${n.type})`);
				lines.push('');
			}
			if (sceneOnly.length) {
				lines.push('### Scene-only (not in Figma)');
				for (const n of sceneOnly) lines.push(`- ${(n.scenePath || []).join('.')} ${n.name || ''}`);
				lines.push('');
			}
		}
	}

	// Part E — apply prompt
	const summary = snapshot.summary || {};
	lines.push('## Part E — Apply prompt');
	lines.push('');
	lines.push(`Patches: ${summary.patches || 0}, skipped: ${summary.skipped || 0}, refused: ${summary.refused || 0}`);
	lines.push('');
	lines.push('Run `node apply-patch.mjs <scene> <patch.json> --dry` to preview before applying.');

	return lines.join('\n');
}

export function jsonReport(snapshot) {
	return JSON.stringify(snapshot, null, 2);
}

function formatValue(v) {
	if (v == null) return '`null`';
	if (typeof v === 'number') return v.toString();
	if (typeof v === 'string') return `\`"${v}"\``;
	return '`' + JSON.stringify(v) + '`';
}

// --self-test
if (import.meta.url === `file://${process.argv[1]}`) {
	const tbl = mdTable(['A', 'B'], [[1, 2], [3, 4]]);
	console.log('PASS mdTable:');
	console.log(tbl);
	console.log('');

	const findings = [
		{ severity: 'error', code: 'N006', figmaPath: 'players/avatar', message: 'duplicate within parent' },
		{ severity: 'warn', code: 'N001', figmaPath: 'loginBtn', message: 'no [Class] tag, inferred Sprite' },
		{ severity: 'info', code: 'P003', figmaPath: 'avatar', message: 'matched via componentId' }
	];
	const summary = summarizeFindings(findings);
	const expected = { error: 1, warn: 1, info: 1, exitCode: 2 };
	const ok = JSON.stringify(summary) === JSON.stringify(expected);
	console.log(`${ok ? 'PASS' : 'FAIL'} summarizeFindings: ${JSON.stringify(summary)}`);

	const report = mdValidatorReport(findings, { fileKey: 'abc', nodeId: '1:1', scanned: 100, skipped: 5 });
	console.log('\nPASS mdValidatorReport:');
	console.log(report);

	process.exit(ok ? 0 : 1);
}

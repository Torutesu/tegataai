#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { verifyExport } from './index.js';

async function readInput(path: string | undefined): Promise<string> {
  if (path !== undefined && path !== '-') return readFileSync(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const path = process.argv[2];
const report = verifyExport(await readInput(path));

for (const issue of report.issues) {
  const where = issue.subject_id === undefined ? `line ${issue.line}` : `${issue.subject_id} seq ${String(issue.seq)}`;
  process.stderr.write(`FAIL  ${where}: ${issue.reason}\n`);
}

const subjects = Object.entries(report.balances);
for (const [subject, b] of subjects.slice(0, 20)) {
  process.stdout.write(
    `${subject}  balance ${b.balance}  reserved ${b.reserved}  available ${b.available}\n`,
  );
}
if (subjects.length > 20) process.stdout.write(`... and ${subjects.length - 20} more subjects\n`);

if (report.ok) {
  process.stdout.write(
    `chain verifies — ${report.entries} entries across ${report.subjects} subjects` +
    `${report.manifestChecked ? ', manifest agrees' : ''}\n`,
  );
  process.exit(0);
}
process.stderr.write(`chain FAILED — ${report.issues.length} issue(s)\n`);
process.exit(1);

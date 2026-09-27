import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { classifyQualification } from './qualification'

const [basePath, baseSha] = process.argv.slice(2)
if (!basePath || !baseSha) throw new Error('Exact PR base policy path and SHA are required')
const candidate = JSON.parse(await readFile('public/model-policy.json', 'utf8')) as unknown
// Only the trusted GitHub base lookup may provide the explicit missing sentinel.
const base = basePath === 'missing' ? undefined : JSON.parse(await readFile(basePath, 'utf8')) as unknown
const report = {
  ...classifyQualification(candidate, base, baseSha),
  candidateSha: process.env.MODEL_POLICY_CANDIDATE_SHA,
  candidateFileSha256: createHash('sha256').update(await readFile('public/model-policy.json')).digest('hex'),
}
await writeFile('model-qualification-report.json', JSON.stringify(report, null, 2))
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `required=${report.required}\nreason=${report.reason}\n`)
console.log(JSON.stringify(report))

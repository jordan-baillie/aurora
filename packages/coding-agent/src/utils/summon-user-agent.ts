export function getSummonUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `summon/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

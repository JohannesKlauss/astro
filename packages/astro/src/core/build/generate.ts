import type { OutputAsset, OutputChunk, RollupOutput } from 'rollup';
import type { PageBuildData } from './types';
import type { AstroConfig, AstroRenderer, ComponentInstance, EndpointHandler, SSRLoadedRenderer } from '../../@types/astro';
import type { StaticBuildOptions } from './types';
import type { BuildInternals } from '../../core/build/internal.js';
import type { RenderOptions } from '../../core/render/core';

import fs from 'fs';
import npath from 'path';
import { fileURLToPath } from 'url';
import { debug, error, info } from '../../core/logger.js';
import { prependForwardSlash } from '../../core/path.js';
import { resolveDependency } from '../../core/util.js';
import { call as callEndpoint } from '../endpoint/index.js';
import { render } from '../render/core.js';
import { createLinkStylesheetElementSet, createModuleScriptElementWithSrcSet } from '../render/ssr-element.js';
import { getOutRoot, getOutFolder, getOutFile } from './common.js';
import { bgMagenta, black, cyan, dim, magenta } from 'kleur/colors';
import { getTimeStat } from './util.js';

// Render is usually compute, which Node.js can't parallelize well.
// In real world testing, dropping from 10->1 showed a notiable perf
// improvement. In the future, we can revisit a smarter parallel
// system, possibly one that parallelizes if async IO is detected.
const MAX_CONCURRENT_RENDERS = 1;

// Utility functions
async function loadRenderer(renderer: AstroRenderer, config: AstroConfig): Promise<SSRLoadedRenderer> {
	const mod = (await import(resolveDependency(renderer.serverEntrypoint, config))) as { default: SSRLoadedRenderer['ssr'] };
	return { ...renderer, ssr: mod.default };
}

async function loadRenderers(config: AstroConfig): Promise<SSRLoadedRenderer[]> {
	return Promise.all(config._ctx.renderers.map((r) => loadRenderer(r, config)));
}

export function getByFacadeId<T>(facadeId: string, map: Map<string, T>): T | undefined {
	return (
		map.get(facadeId) ||
		// Windows the facadeId has forward slashes, no idea why
		map.get(facadeId.replace(/\//g, '\\'))
	);
}

// Throttle the rendering a paths to prevents creating too many Promises on the microtask queue.
function* throttle(max: number, inPaths: string[]) {
	let tmp = [];
	let i = 0;
	for (let path of inPaths) {
		tmp.push(path);
		if (i === max) {
			yield tmp;
			// Empties the array, to avoid allocating a new one.
			tmp.length = 0;
			i = 0;
		} else {
			i++;
		}
	}

	// If tmp has items in it, that means there were less than {max} paths remaining
	// at the end, so we need to yield these too.
	if (tmp.length) {
		yield tmp;
	}
}

// Gives back a facadeId that is relative to the root.
// ie, src/pages/index.astro instead of /Users/name..../src/pages/index.astro
export function rootRelativeFacadeId(facadeId: string, astroConfig: AstroConfig): string {
	return facadeId.slice(fileURLToPath(astroConfig.projectRoot).length);
}

// Determines of a Rollup chunk is an entrypoint page.
export function chunkIsPage(astroConfig: AstroConfig, output: OutputAsset | OutputChunk, internals: BuildInternals) {
	if (output.type !== 'chunk') {
		return false;
	}
	const chunk = output as OutputChunk;
	if (chunk.facadeModuleId) {
		const facadeToEntryId = prependForwardSlash(rootRelativeFacadeId(chunk.facadeModuleId, astroConfig));
		return internals.entrySpecifierToBundleMap.has(facadeToEntryId);
	}
	return false;
}

export async function generatePages(result: RollupOutput, opts: StaticBuildOptions, internals: BuildInternals, facadeIdToPageDataMap: Map<string, PageBuildData>) {
	info(opts.logging, null, `\n${bgMagenta(black(' generating static routes '))}\n`);

	// Get renderers to be shared for each page generation.
	const renderers = await loadRenderers(opts.astroConfig);

	for (let output of result.output) {
		if (chunkIsPage(opts.astroConfig, output, internals)) {
			await generatePage(output as OutputChunk, opts, internals, facadeIdToPageDataMap, renderers);
		}
	}
}

async function generatePage(
	output: OutputChunk,
	opts: StaticBuildOptions,
	internals: BuildInternals,
	facadeIdToPageDataMap: Map<string, PageBuildData>,
	renderers: SSRLoadedRenderer[]
) {
	let timeStart = performance.now();
	const { astroConfig } = opts;

	let url = new URL('./' + output.fileName, getOutRoot(astroConfig));
	const facadeId: string = output.facadeModuleId as string;
	let pageData = getByFacadeId<PageBuildData>(facadeId, facadeIdToPageDataMap);

	if (!pageData) {
		throw new Error(`Unable to find a PageBuildData for the Astro page: ${facadeId}. There are the PageBuildDatas we have ${Array.from(facadeIdToPageDataMap.keys()).join(', ')}`);
	}

	const linkIds = getByFacadeId<string[]>(facadeId, internals.facadeIdToAssetsMap) || [];
	const hoistedId = getByFacadeId<string>(facadeId, internals.facadeIdToHoistedEntryMap) || null;

	let compiledModule = await import(url.toString());

	const generationOptions: Readonly<GeneratePathOptions> = {
		pageData,
		internals,
		linkIds,
		hoistedId,
		mod: compiledModule,
		renderers,
	};

	const icon = pageData.route.type === 'page' ? cyan('</>') : magenta('{-}');
	info(opts.logging, null, `${icon} ${pageData.route.component}`);

	// Throttle the paths to avoid overloading the CPU with too many tasks.
	const renderPromises = [];
	for (const paths of throttle(MAX_CONCURRENT_RENDERS, pageData.paths)) {
		for (const path of paths) {
			renderPromises.push(generatePath(path, opts, generationOptions));
		}
		// This blocks generating more paths until these 10 complete.
		await Promise.all(renderPromises);
		const timeEnd = performance.now();
		const timeChange = getTimeStat(timeStart, timeEnd);
		let shouldLogTimeChange = !getTimeStat(timeStart, timeEnd).startsWith('0');
		for (const path of paths) {
			const timeIncrease = shouldLogTimeChange ? ` ${dim(`+${timeChange}`)}` : '';
			info(opts.logging, null, `    ${dim('┃')} ${path}${timeIncrease}`);
			// Should only log build time on the first generated path
			// Logging for all generated paths adds extra noise
			shouldLogTimeChange = false;
		}
		// Reset timeStart for the next batch of rendered paths
		timeStart = performance.now();
		// This empties the array without allocating a new one.
		renderPromises.length = 0;
	}
}

interface GeneratePathOptions {
	pageData: PageBuildData;
	internals: BuildInternals;
	linkIds: string[];
	hoistedId: string | null;
	mod: ComponentInstance;
	renderers: SSRLoadedRenderer[];
}

function addPageName(pathname: string, opts: StaticBuildOptions): void {
	opts.pageNames.push(pathname.replace(/\/?$/, '/').replace(/^\//, ''));
}

async function generatePath(pathname: string, opts: StaticBuildOptions, gopts: GeneratePathOptions) {
	const { astroConfig, logging, origin, routeCache } = opts;
	const { mod, internals, linkIds, hoistedId, pageData, renderers } = gopts;

	// This adds the page name to the array so it can be shown as part of stats.
	if (pageData.route.type === 'page') {
		addPageName(pathname, opts);
	}

	debug('build', `Generating: ${pathname}`);

	const site = astroConfig.buildOptions.site;
	const links = createLinkStylesheetElementSet(linkIds.reverse(), site);
	const scripts = createModuleScriptElementWithSrcSet(hoistedId ? [hoistedId] : [], site);

	// Add all injected scripts to the page.
	for (const script of astroConfig._ctx.scripts) {
		if (script.stage === 'head-inline') {
			scripts.add({
				props: {},
				children: script.content,
			});
		}
	}

	try {
		const options: RenderOptions = {
			legacyBuild: false,
			links,
			logging,
			markdownRender: astroConfig.markdownOptions.render,
			mod,
			origin,
			pathname,
			scripts,
			renderers,
			async resolve(specifier: string) {
				const hashedFilePath = internals.entrySpecifierToBundleMap.get(specifier);
				if (typeof hashedFilePath !== 'string') {
					// If no "astro:scripts/before-hydration.js" script exists in the build,
					// then we can assume that no before-hydration scripts are needed.
					// Return this as placeholder, which will be ignored by the browser.
					// TODO: In the future, we hope to run this entire script through Vite,
					// removing the need to maintain our own custom Vite-mimic resolve logic.
					if (specifier === 'astro:scripts/before-hydration.js') {
						return 'data:text/javascript;charset=utf-8,//[no before-hydration script]';
					}
					throw new Error(`Cannot find the built path for ${specifier}`);
				}
				const relPath = npath.posix.relative(pathname, '/' + hashedFilePath);
				const fullyRelativePath = relPath[0] === '.' ? relPath : './' + relPath;
				return fullyRelativePath;
			},
			method: 'GET',
			headers: new Headers(),
			route: pageData.route,
			routeCache,
			site: astroConfig.buildOptions.site,
			ssr: opts.astroConfig.buildOptions.experimentalSsr,
		};

		let body: string;
		if (pageData.route.type === 'endpoint') {
			const result = await callEndpoint(mod as unknown as EndpointHandler, options);

			if (result.type === 'response') {
				throw new Error(`Returning a Response from an endpoint is not supported in SSG mode.`);
			}
			body = result.body;
		} else {
			const result = await render(options);

			// If there's a redirect or something, just do nothing.
			if (result.type !== 'html') {
				return;
			}
			body = result.html;
		}

		const outFolder = getOutFolder(astroConfig, pathname, pageData.route.type);
		const outFile = getOutFile(astroConfig, outFolder, pathname, pageData.route.type);
		await fs.promises.mkdir(outFolder, { recursive: true });
		await fs.promises.writeFile(outFile, body, 'utf-8');
	} catch (err) {
		error(opts.logging, 'build', `Error rendering:`, err);
	}
}
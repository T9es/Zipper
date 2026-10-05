#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assemblyName = 'Jellyfin.Plugin.Zipper';
const pluginGuid = '78e5c3be-072f-4ea5-8c49-01d6f61a50ad';
const projectPath = path.join(root, 'src', assemblyName, `${assemblyName}.csproj`);
const assemblyDirectory = path.join(root, 'src', assemblyName, 'bin', 'Release', 'net10.0');

function fail(message) {
  console.error(`package: ${message}`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || key.length < 3) {
      throw new Error(`unexpected argument: ${key}`);
    }
    if (options.has(key)) {
      throw new Error(`option supplied more than once: ${key}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${key}`);
    }
    options.set(key, value);
    index += 1;
  }

  for (const key of options.keys()) {
    if (!['--version', '--output-dir', '--repository', '--release-tag', '--previous-manifest'].includes(key)) {
      throw new Error(`unknown option: ${key}`);
    }
  }

  const version = options.get('--version');
  const outputDirectory = options.get('--output-dir');
  const repository = options.get('--repository');
  const releaseTag = options.get('--release-tag');
  const previousManifest = options.get('--previous-manifest');
  if (!version || !outputDirectory) {
    throw new Error('usage: node scripts/package.mjs --version X.Y.Z.W --output-dir DIR [--repository OWNER/REPO --release-tag vX.Y.Z.W] [--previous-manifest FILE]');
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version must have four numeric components: ${version}`);
  }
  if (Boolean(repository) !== Boolean(releaseTag)) {
    throw new Error('--repository and --release-tag must be supplied together');
  }
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`invalid GitHub repository name: ${repository}`);
  }
  if (releaseTag && releaseTag !== `v${version}`) {
    throw new Error(`release tag must be v${version}; received ${releaseTag}`);
  }
  if (previousManifest && !repository) {
    throw new Error('--previous-manifest requires --repository and --release-tag');
  }
  return {
    version,
    outputDirectory: path.resolve(process.cwd(), outputDirectory),
    repository,
    releaseTag,
    previousManifest: previousManifest ? path.resolve(process.cwd(), previousManifest) : undefined,
  };
}

function validatePreviousVersions(previousText, repository, plugin) {
  const previousManifest = JSON.parse(previousText);
  if (!Array.isArray(previousManifest) || previousManifest.length !== 1) {
    throw new Error('previous manifest must contain exactly one plugin entry');
  }

  const previousPlugin = previousManifest[0];
  if (previousPlugin.guid?.toLowerCase() !== plugin.guid.toLowerCase()
    || previousPlugin.name !== plugin.name
    || previousPlugin.owner?.toLowerCase() !== plugin.owner.toLowerCase()) {
    throw new Error('previous manifest does not match the Zipper plugin identity');
  }
  if (!Array.isArray(previousPlugin.versions)) {
    throw new Error('previous manifest plugin entry must have a versions array');
  }

  const seenVersions = new Set();
  for (const entry of previousPlugin.versions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('previous manifest contains an invalid version entry');
    }
    const version = entry.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
      throw new Error('previous manifest contains a version without four numeric components');
    }
    if (seenVersions.has(version)) {
      throw new Error(`previous manifest contains duplicate version ${version}`);
    }
    seenVersions.add(version);

    if (typeof entry.targetAbi !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(entry.targetAbi)) {
      throw new Error(`previous manifest version ${version} has an invalid target ABI`);
    }
    if (typeof entry.changelog !== 'string') {
      throw new Error(`previous manifest version ${version} has no changelog`);
    }
    if (typeof entry.checksum !== 'string' || !/^[a-f0-9]{32}$/i.test(entry.checksum)) {
      throw new Error(`previous manifest version ${version} has an invalid MD5 checksum`);
    }
    if (typeof entry.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.timestamp)
      || Number.isNaN(Date.parse(entry.timestamp))) {
      throw new Error(`previous manifest version ${version} has an invalid timestamp`);
    }

    const expectedUrl = new URL(
      `https://github.com/${repository}/releases/download/v${version}/${assemblyName}_${version}.zip`,
    );
    let sourceUrl;
    try {
      sourceUrl = new URL(entry.sourceUrl);
    } catch {
      throw new Error(`previous manifest version ${version} has an invalid source URL`);
    }
    if (sourceUrl.href !== expectedUrl.href) {
      throw new Error(`previous manifest version ${version} does not point to its Zipper release asset`);
    }
  }

  return previousPlugin.versions;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipFiles(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  if (entries.length > 0xffff) {
    throw new Error('too many files for a plugin installer ZIP');
  }

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const original = entry.bytes;
    const compressed = deflateRawSync(original, { level: 9 });
    const checksum = crc32(original);
    if (name.length > 0xffff || original.length > 0xffffffff || compressed.length > 0xffffffff || localOffset > 0xffffffff) {
      throw new Error(`file is too large for a non-ZIP64 installer archive: ${entry.name}`);
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(original.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(original.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (localOffset > 0xffffffff || centralDirectory.length > 0xffffffff) {
    throw new Error('plugin installer archive exceeds the supported ZIP size');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function isJellyfinHostAssembly(filename) {
  const name = path.basename(filename, '.dll');
  return /^(?:Jellyfin|Emby|MediaBrowser|Microsoft|System)(?:\.|$)/i.test(name)
    || /^(?:mscorlib|netstandard)$/i.test(name);
}

async function readFileEntry(filePath, archiveName) {
  const file = await open(filePath, 'r');
  try {
    const information = await file.stat();
    if (!information.isFile()) {
      throw new Error(`expected a regular file: ${filePath}`);
    }
    return { name: archiveName, bytes: await file.readFile() };
  } finally {
    await file.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [metadataText, projectText] = await Promise.all([
    readFile(path.join(root, 'meta.json'), 'utf8'),
    readFile(projectPath, 'utf8'),
  ]);
  const metadata = JSON.parse(metadataText);

  if (metadata.guid?.toLowerCase() !== pluginGuid || metadata.name !== 'Zipper') {
    throw new Error('meta.json does not match the Zipper plugin identity');
  }
  if (metadata.version !== options.version) {
    throw new Error(`requested version ${options.version} does not match meta.json version ${metadata.version}`);
  }
  if (metadata.targetAbi !== '12.0.0.0' || metadata.framework !== 'net10.0') {
    throw new Error('meta.json must declare the configured Jellyfin 12 / .NET 10 target');
  }

  const projectVersion = projectText.match(/<Version>\s*([^<\s]+)\s*<\/Version>/)?.[1];
  if (projectVersion !== options.version) {
    throw new Error(`project <Version> must be ${options.version}; found ${projectVersion ?? 'no literal <Version> property'}`);
  }

  const mainAssemblyPath = path.join(assemblyDirectory, `${assemblyName}.dll`);
  const files = await readdir(assemblyDirectory);
  const runtimeAssemblies = files
    .filter((filename) => filename.toLowerCase().endsWith('.dll'))
    .filter((filename) => filename !== `${assemblyName}.dll` && !isJellyfinHostAssembly(filename))
    .sort((left, right) => left.localeCompare(right));

  const entries = [
    await readFileEntry(mainAssemblyPath, `${assemblyName}.dll`),
    ...await Promise.all(runtimeAssemblies.map((filename) => readFileEntry(path.join(assemblyDirectory, filename), filename))),
    await readFileEntry(path.join(root, 'meta.json'), 'meta.json'),
    await readFileEntry(path.join(root, 'assets', 'icon.svg'), 'icon.svg'),
    await readFileEntry(path.join(root, 'LICENSE'), 'LICENSE'),
  ];
  const dependencyManifest = path.join(assemblyDirectory, `${assemblyName}.deps.json`);
  try {
    entries.push(await readFileEntry(dependencyManifest, `${assemblyName}.deps.json`));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new Error(`duplicate installer filename: ${entry.name}`);
    }
    names.add(entry.name);
  }

  const archiveName = `${assemblyName}_${options.version}.zip`;
  const archivePath = path.join(options.outputDirectory, archiveName);
  const archiveBytes = zipFiles(entries);

  if (!options.repository) {
    await mkdir(options.outputDirectory, { recursive: true });
    await writeFile(archivePath, archiveBytes);
    console.log(`Created ${path.relative(process.cwd(), archivePath)}`);
    return;
  }

  const repositoryMetadata = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (!Array.isArray(repositoryMetadata) || repositoryMetadata.length !== 1) {
    throw new Error('manifest.json must contain exactly the Zipper repository entry');
  }
  const plugin = repositoryMetadata[0];
  if (plugin.guid?.toLowerCase() !== pluginGuid || plugin.name !== metadata.name) {
    throw new Error('manifest.json does not match the Zipper plugin identity');
  }
  const previousVersions = options.previousManifest
    ? validatePreviousVersions(await readFile(options.previousManifest, 'utf8'), options.repository, plugin)
      .filter((entry) => entry.version !== options.version)
    : [];

  const checksum = createHash('md5').update(archiveBytes).digest('hex');
  const sourceUrl = `https://github.com/${options.repository}/releases/download/${options.releaseTag}/${archiveName}`;
  const catalogManifest = [{
    ...plugin,
    versions: [
      {
        version: options.version,
        changelog: metadata.changelog,
        targetAbi: metadata.targetAbi,
        sourceUrl,
        checksum,
        timestamp: new Date().toISOString(),
      },
      ...previousVersions,
    ],
  }];
  const catalogPath = path.join(options.outputDirectory, 'manifest.json');
  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(archivePath, archiveBytes);
  console.log(`Created ${path.relative(process.cwd(), archivePath)}`);
  await writeFile(catalogPath, `${JSON.stringify(catalogManifest, null, 2)}\n`, 'utf8');
  console.log(`Created ${path.relative(process.cwd(), catalogPath)} (MD5 ${checksum})`);
}

main().catch((error) => {
  fail(error.message);
});

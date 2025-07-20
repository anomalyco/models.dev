#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';

console.log("Building OpenModes...");

const srcDir = path.join(import.meta.dir, '..', 'src');
const publicDir = path.join(import.meta.dir, '..', 'public');
const distDir = path.join(import.meta.dir, '..', 'dist');
const isProduction = process.env.NODE_ENV === 'production';

console.log(`Build mode: ${isProduction ? 'production' : 'development'}`);

// Clean and create dist directory
if (existsSync(distDir)) {
  console.log("Cleaning previous build...");
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir, { recursive: true });

try {
  // Build client-side JavaScript from TypeScript
  console.log("Building client-side JavaScript...");
  const entrypoint = path.join(srcDir, 'index.ts');
  
  if (!existsSync(entrypoint)) {
    throw new Error(`Entry point not found: ${entrypoint}`);
  }

  const buildResult = await Bun.build({
    entrypoints: [entrypoint],
    outdir: distDir,
    target: 'browser',
    format: 'esm',
    minify: isProduction,
    sourcemap: isProduction ? 'none' : 'external',
    naming: '[dir]/[name].[ext]',
    splitting: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
    }
  });

  if (!buildResult.success) {
    console.error("Build failed:");
    buildResult.logs.forEach(log => console.error(log));
    process.exit(1);
  }

  // Copy CSS file to dist
  console.log("Copying CSS files...");
  const cssSource = path.join(srcDir, 'index.css');
  if (existsSync(cssSource)) {
    const cssTarget = path.join(distDir, 'index.css');
    await Bun.write(cssTarget, Bun.file(cssSource));
    console.log(`  ✓ Copied ${path.basename(cssSource)}`);
  } else {
    console.warn(`  ⚠ CSS file not found: ${cssSource}`);
  }

  // Copy public assets to dist
  if (existsSync(publicDir)) {
    console.log("Copying public assets...");
    try {
      const result = await Bun.$`find ${publicDir} -type f`.text();
      const files = result.trim().split('\n').filter(Boolean);
      
      for (const file of files) {
        const relativePath = path.relative(publicDir, file);
        const targetPath = path.join(distDir, relativePath);
        const targetDir = path.dirname(targetPath);
        
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }
        
        await Bun.write(targetPath, Bun.file(file));
        console.log(`  ✓ Copied ${relativePath}`);
      }
    } catch (error) {
      console.warn("  ⚠ Error copying public assets:", error);
    }
  } else {
    console.log("No public assets directory found, skipping...");
  }

  // Display build results
  console.log("\n✅ Build completed successfully!");
  console.log(`📁 Output directory: ${path.relative(process.cwd(), distDir)}/`);
  console.log("📄 Built files:");
  
  buildResult.outputs.forEach(output => {
    const relativePath = path.relative(distDir, output.path);
    const stats = Bun.file(output.path).size;
    console.log(`  - ${relativePath} (${Math.round(stats / 1024)}kb)`);
  });

  // Check if CSS was built
  const cssInDist = path.join(distDir, 'index.css');
  if (existsSync(cssInDist)) {
    const cssStats = Bun.file(cssInDist).size;
    console.log(`  - index.css (${Math.round(cssStats / 1024)}kb)`);
  }

} catch (error) {
  console.error("❌ Build failed:", error);
  process.exit(1);
}
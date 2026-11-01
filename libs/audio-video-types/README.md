# `@audio-video/types`

Canonical TypeScript contracts for Media artifacts, jobs, providers, and
audio/video operations. The package publishes ESM and CommonJS entry points at
`.`, `./contracts`, and `./production`.

## Local build

From the repository root:

```sh
pnpm --filter @audio-video/types clean
pnpm --filter @audio-video/types build
pnpm --filter @audio-video/types test
```

The build emits ESM JavaScript and declarations under `dist/`, and CommonJS
JavaScript under `dist-cjs/`. Build and clean helper scripts use Node APIs so
they work on Windows as well as Unix platforms.

## Verify the packed consumer surface

These opt-in checks verify the package tarball without publishing it. They are
not part of the default unit suite. Use a fresh temporary consumer directory
and a package tarball path appropriate for the host OS.

From the repository root, build and pack to a temporary directory:

```sh
pnpm --filter @audio-video/types clean
pnpm --filter @audio-video/types build
pnpm --filter @audio-video/types pack --pack-destination <temporary-directory>
```

In a fresh consumer directory, install the tarball and TypeScript 6.0.3:

```sh
npm init -y
npm install <path-to-audio-video-types-tarball> typescript@6.0.3
```

Create `consumer.mts` to check ESM declarations:

```ts
import { createAudioData } from "@audio-video/types";
import { MediaProcessingJobSchema } from "@audio-video/types/contracts";
import { ProductionSpecSchema } from "@audio-video/types/production";

createAudioData(new ArrayBuffer(0));
MediaProcessingJobSchema.parse({});
ProductionSpecSchema.parse({});
```

Create `consumer.cts` to check CommonJS declarations:

```ts
import types = require("@audio-video/types");
import contracts = require("@audio-video/types/contracts");
import production = require("@audio-video/types/production");

types.createAudioData(new ArrayBuffer(0));
contracts.MediaProcessingJobSchema.parse({});
production.ProductionSpecSchema.parse({});
```

Create `tsconfig.json` and run the compiler:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": false
  },
  "include": ["*.mts", "*.cts"]
}
```

```sh
npx tsc -p tsconfig.json
```

Also check runtime resolution from that installed consumer:

```sh
node --input-type=module -e "import * as a from '@audio-video/types'; import * as b from '@audio-video/types/contracts'; import * as c from '@audio-video/types/production'; if (!a.createAudioData || !b.MediaProcessingJobSchema || !c.ProductionSpecSchema) process.exit(1)"
node -e "const a=require('@audio-video/types'),b=require('@audio-video/types/contracts'),c=require('@audio-video/types/production'); if(!a.createAudioData||!b.MediaProcessingJobSchema||!c.ProductionSpecSchema)process.exit(1)"
```

Installing the tarball and TypeScript may contact the configured npm registry.
These checks do not publish the package and are intentionally not run by the
default unit-test command.

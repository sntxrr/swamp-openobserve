# swamp-openobserve

The `@sntxrr/openobserve` swamp extension.

Source lives in [`extensions/models/openobserve/`](extensions/models/openobserve/);
see that directory's [README](extensions/models/openobserve/README.md) for the
model's methods, arguments and the reasoning behind them.

## Development

```bash
~/.swamp/deno/deno check extensions/models/openobserve/openobserve.ts
~/.swamp/deno/deno test  extensions/models/openobserve/openobserve_test.ts
swamp extension fmt     extensions/models/openobserve/manifest.yaml --check
swamp extension quality extensions/models/openobserve/manifest.yaml --json
swamp extension push    extensions/models/openobserve/manifest.yaml --dry-run
```

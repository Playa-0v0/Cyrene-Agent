# Cyrene Opener Pack

Place the active opener voice pack in this directory when running from source.

Required layout:

```text
opener-pack/
├── manifest.json
└── morning/
    └── m01.wav
```

`npm run dev` and `npm run start` read this directory. A packaged exe reads
`userData/cyrene-opener-pack` instead.

Only this README and `.gitkeep` are tracked. Local `manifest.json`, wav files,
and pack subdirectories are ignored by Git.

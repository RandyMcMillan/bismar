// Tests for the `bismar` binary: bundle + size.
// Deterministic machine-mode output regardless of TTY; FORCE_COLOR sub-tests override.
process.env.NO_COLOR = '1';

import './bin.test.ts';
import './bundle.test.ts';
import './camel-parts.test.ts';
import './diff.test.ts';
import './fs-modify.test.ts';
import './interactive.test.ts';
import './public.test.ts';
import './registries.test.ts';
import './size.test.ts';
import './surface.test.ts';
import './vectors.test.ts';

import { deepStrictEqual } from 'node:assert';
import { test as it } from 'node:test';
import { camel } from '../src/size.ts';

it('camel converts names to camelCase global identifiers', () => {
  deepStrictEqual(camel('noble-curves'), 'nobleCurves');
  deepStrictEqual(camel('@namespace/ab_cd'), 'namespaceAbCd');
  deepStrictEqual(camel('single'), 'single');
});

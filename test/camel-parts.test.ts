import { deepStrictEqual } from 'node:assert';
import { test as should } from 'node:test';
import { camel } from '../src/size.ts';

should('camel converts names to camelCase global identifiers', () => {
  deepStrictEqual(camel('noble-curves'), 'nobleCurves');
  deepStrictEqual(camel('@namespace/ab_cd'), 'namespaceAbCd');
  deepStrictEqual(camel('single'), 'single');
});

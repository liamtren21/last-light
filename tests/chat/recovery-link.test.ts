import {test,expect} from 'vitest';
import {recoveryLink,recoveryCodeFrom} from '../../src/ui/recovery-link';
test('transfer credential stays in fragment and accepts only same-origin pasted links',()=>{
 const origin='https://last-light.example';const code='private-token';const link=recoveryLink(code,origin);
 expect(new URL(link).search).toBe('');expect(recoveryCodeFrom(link,origin)).toBe(code);
 expect(recoveryCodeFrom(recoveryLink(code,'https://foreign.example'),origin)).toBe('');
 expect(recoveryCodeFrom('  '+code+'  ',origin)).toBe(code);
});

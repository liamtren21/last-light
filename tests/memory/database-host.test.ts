import {expect,test} from 'vitest';
import {isPrivateDatabaseHost} from '../../server/database-host';
test.each(['localhost','127.0.0.1','db','host.docker.internal','postgres.railway.internal'])('allows explicitly unencrypted private DB: %s',host=>{
  expect(isPrivateDatabaseHost(host)).toBe(true);
});
test.each(['example.com','railway.internal.example.com','postgres.railway.app','railway.internal'])('rejects public or misleading DB hosts: %s',host=>{
  expect(isPrivateDatabaseHost(host)).toBe(false);
});

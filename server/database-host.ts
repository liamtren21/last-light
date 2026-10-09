export function isPrivateDatabaseHost(host:string){
  return ['db','localhost','127.0.0.1','host.docker.internal'].includes(host)||host.endsWith('.railway.internal');
}

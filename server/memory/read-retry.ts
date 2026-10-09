/** Reads only: retry a single transient transport error; never retry auth or invalid evidence. */
export async function retryTransientRead<T>(operation:()=>Promise<T>,canRetry:()=>boolean=()=>true):Promise<T>{
 try{return await operation();}catch(error){
  const status=(error as {status?:number}).status;
  if(!canRetry()||![502,503,504].includes(status??0)&&!(error instanceof TypeError&&/fetch|network/i.test(error.message)))throw error;
  return operation();
 }
}

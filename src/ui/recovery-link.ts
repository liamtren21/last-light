export function recoveryLink(code:string,origin:string){return `${origin}/#restore=${encodeURIComponent(code)}`;}
export function recoveryCodeFrom(value:string,origin:string){
 const input=value.trim();
 if(!input.includes('://'))return input;
 try{const url=new URL(input);return url.origin===origin?new URLSearchParams(url.hash.slice(1)).get('restore')??'':'';}catch{return '';}
}
// Remove bearer credentials before loading assets or making API requests.
export function takeRecoveryLink(){
 const params=new URLSearchParams(location.hash.slice(1));
 if(!params.has('restore'))return '';
 const code=params.get('restore')??'';
 history.replaceState(history.state,'',location.pathname+location.search);
 return code;
}

// Native-fetch YouTube transport for the bounded apply route: no SDK, no hidden
// retry/replay, fixed official HTTPS endpoints, redirects refused, bounded
// timeouts. Exactly one refresh POST per client (lazy, shared across calls);
// every API call is a single attempt. Success and non-2xx responses retain
// status and full raw body for sealed evidence; transport/timeout/parse
// failures carry a truthful phase marker and, for non-GET calls, an 'uncertain'
// flag because the request may have reached the provider. Internal
// classification fields are never logged.
const TOKEN_URL='https://oauth2.googleapis.com/token';
const API_BASE='https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS=15000;
async function refreshToken(clientId,clientSecret,refreshTokenValue){
  let res;
  try {
    res=await fetch(TOKEN_URL,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshTokenValue,grant_type:'refresh_token'}),redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});
  } catch { throw new Error('refresh failed'); }
  if (!res.ok) throw new Error('refresh failed');
  let body=null;
  try { body=await res.json(); } catch { throw new Error('refresh failed'); }
  if (typeof body.access_token!=='string'||!body.access_token) throw new Error('refresh failed');
  return body.access_token;
}
export function makeNativeClient(clientId,clientSecret,refreshTokenValue){
  let access=null;
  const call=async(method,path,params,requestBody,headers)=>{
    access??=await refreshToken(clientId,clientSecret,refreshTokenValue);
    const qs=new URLSearchParams();
    for (const [k,v] of Object.entries(params??{})) qs.set(k,Array.isArray(v)?v.join(','):String(v));
    let res;
    try {
      res=await fetch(`${API_BASE}${path}?${qs}`,{method,headers:{authorization:`Bearer ${access}`,...(requestBody?{'content-type':'application/json'}:{}),...(headers??{})},body:requestBody?JSON.stringify(requestBody):undefined,redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS)});
    } catch {
      const err=new Error('api call unreachable');
      err.phase='transport';err.uncertain=method!=='GET';err.apiStatus=null;err.apiBody=null;err.bodyReadFailed=false;
      throw err;
    }
    // Full raw body is retained for sealed evidence - never silently capped or
    // truncated. A body that cannot be READ keeps its truthful phase marker.
    let text=null;
    try { text=await res.text(); } catch {
      const err=new Error('api response body unreadable');
      err.phase='body-read';err.apiStatus=res.status;err.apiBody=null;err.bodyReadFailed=true;err.uncertain=method!=='GET';
      throw err;
    }
    const receivedAt=new Date().toISOString();
    let data=null;
    try { data=JSON.parse(text); } catch {}
    if (!res.ok) {
      const err=new Error('api call failed');
      err.phase='response';err.apiStatus=res.status;err.apiBody=text;err.bodyReadFailed=false;
      err.apiReason=data?.error?.errors?.[0]?.reason??'';err.receivedAt=receivedAt;
      throw err;
    }
    if (data===null||typeof data!=='object') {
      const err=new Error('api response unreadable');
      err.phase='parse';err.apiStatus=res.status;err.apiBody=text;err.bodyReadFailed=false;err.uncertain=method!=='GET';err.receivedAt=receivedAt;
      throw err;
    }
    return {status:res.status,data,rawBody:text,receivedAt};
  };
  return {
    channels:{list:(params)=>call('GET','/channels',params)},
    videos:{list:(params)=>call('GET','/videos',params),update:(params,opts)=>call('PUT','/videos',{part:params.part},params.requestBody,opts?.headers)},
  };
}

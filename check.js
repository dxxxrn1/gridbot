require('dotenv').config();
console.log('URL:', JSON.stringify(process.env.SUPABASE_URL));
fetch(process.env.SUPABASE_URL + '/rest/v1/', {
  headers: { apikey: process.env.SUPABASE_SERVICE_KEY },
})
  .then((r) => console.log('Reached Supabase, status:', r.status))
  .catch((e) => console.log('FAILED:', e.cause || e));

const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

async function verifyLineIdToken(idToken, channelId) {
  const resp = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });
  const data = await resp.json();
  if (!data.sub) throw new Error("Invalid LINE id_token");
  return data; // { sub, name?, picture? }
}

module.exports = { verifyLineIdToken };

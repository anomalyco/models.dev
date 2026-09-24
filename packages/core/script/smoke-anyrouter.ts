const key = process.env.ANYROUTER_API_KEY;
if (!key) {
  console.error("ANYROUTER_API_KEY is not set");
  process.exit(1);
}

const response = await fetch("https://anyrouter.dev/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "anyrouter/free",
    messages: [{ role: "user", content: "Reply with exactly: anyrouter ok" }],
  }),
});

const data = await response.json();
if (!response.ok) {
  console.error(response.status, data);
  process.exit(1);
}

console.log(`model=${data.model}`);
console.log(data.choices?.[0]?.message?.content);

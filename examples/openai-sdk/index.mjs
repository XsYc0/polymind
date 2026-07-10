import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local-polymind-key",
  baseURL: "http://localhost:8080/v1"
});

const response = await client.chat.completions.create({
  model: "polymind/auto",
  messages: [{ role: "user", content: "Explain what PolyMind does." }]
});

console.log(response.choices[0]?.message?.content);
console.log(response.polymind);

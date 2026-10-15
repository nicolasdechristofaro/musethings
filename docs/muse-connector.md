# Connecting Muse to Things

You need the public URL (`node src/cli.ts config set publicUrl …` on the spare Mac) and the API key from `keygen`.

1. Open Muse and start a chat.
2. Paste this, with your URL and key filled in:

   > Create a custom connector called "Things" for my Things 3 to-dos. Its API is described at
   > https://YOUR-MAC.YOUR-TAILNET.ts.net/openapi.json. Authenticate every request with the header
   > `Authorization: Bearer YOUR-KEY`. Operations tagged "sensitive" (moving to the Trash,
   > completing or canceling a whole project) must always be confirmed with me first. Look up ids with
   > the read operations before changing anything.

3. If Muse asks how to authenticate, choose API key / bearer token and paste the key.
4. Test it: "What's on my Today list in Things?"

If you rotate the key (`node src/cli.ts keygen`), update it in Muse → Settings → Connectors → Things.

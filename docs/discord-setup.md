# Discord Setup

Windsor needs a Discord application installed in the server whose messages it
will monitor.

## Create a Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and select **New Application**.
2. Give the application a name and open its **Bot** page.
3. Click **Reset Token**, then copy the token. Treat it like a password: do
   not commit it, paste it into public issues, or share it. Discord will not
   show the token again without resetting it.
4. On the **Bot** page, enable the **Message Content Intent**. Windsor reads
   ordinary message text, so this privileged intent is required. Windsor also
   uses guilds, guild messages, and guild message reactions.

## Invite the bot to your server

From the application's **Installation** or **OAuth2 > URL Generator** page,
create an installation URL with the `bot` scope. Grant these permissions:

* View Channels
* Send Messages
* Read Message History
* Add Reactions

Open the generated URL, choose the target server, and authorize it. The person
installing the bot must have permission to manage the server. The bot must be
able to view and read history in every channel that Windsor monitors.

## Configure Windsor

Enter the bot token in the Windsor control panel's **Discord Token** field.
Optionally enter the server ID to restrict Windsor to one server. To copy IDs
in Discord, enable **Developer Mode**, then right-click the server and choose
**Copy Server ID**.

The token may instead be supplied through the `DISCORD_TOKEN` environment
variable. The optional server restriction uses `SERVER_ID`.

## Sources

* [Discord: Building your first Discord bot](https://docs.discord.com/developers/quick-start/getting-started)
* [Discord: OAuth2 and bot authorization](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow)

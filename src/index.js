const { Client, GatewayIntentBits, Events, PermissionFlagsBits, ActivityType } = require('discord.js');
const { config, validate } = require('./config');
const db = require('./db');
const { handleInteraction, handlePrefixMute } = require('./commands');
const { handlePrefixRoleCommands } = require('./hoster-role-commands');
const { hasPermission } = require('./access');
const eventSystem = require('./event');
const annihilateSystem = require('./annihilate');
const wordkillSystem = require('./wordkill');
const politicalTriviaSystem = require('./political-trivia');
const guessPoliticianSystem = require('./guess-the-politician');
const flagRushSystem = require('./flagrush');
const mysteryGenSystem = require('./mysterygen');
const chessPuzzleSystem = require('./chess-puzzle');
const learningGames = require('./learning-games');
const newsSystem = require('./news');
const qotdSystem = require('./qotd');
const boosterAssets = require('./booster-assets');
const chatRevivalSystem = require('./chat-revival');
const automationControl = require('./automation-control');
const gameRotationSystem = require('./game-rotation');
const staffAnalytics = require('./staff-analytics');
const staffRanking = require('./staff-ranking');
const { registerApplicationCommands } = require('./command-registration');

validate();


const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  readyClient.user.setPresence({
    status: 'online',
    activities: [
      {
        name: 'Initiating Orbital Strike on NR3.. 🚀',
        type: ActivityType.Playing
      },
      {
        name: 'Custom Status',
        type: ActivityType.Custom,
        state: 'PLAY /STEAL_OR_NOSTEAL RIGHT NOW IN NRR!'
      }
    ]
  });
  try {
    await registerApplicationCommands();
    await db.migrate();
    await staffAnalytics.migrate();
    await staffRanking.startScheduler(readyClient);
    await qotdSystem.migrate();
    await boosterAssets.migrate();
    console.log('Database migrations ready.');
    await staffAnalytics.backfillAuditLogs(readyClient);
    setInterval(() => staffAnalytics.backfillAuditLogs(readyClient).catch(error => console.error('Punishment audit scan failed:', error)), 10 * 60 * 1000);

    setInterval(() => eventSystem.autoApprove(readyClient).catch(error => console.error('Event auto-approval failed:', error)), 30 * 1000);
    newsSystem.start(readyClient);
    // Temporarily disabled by administrator request: no Chat Revival or automatic game-invitation messages.
    console.log('Chat Revival and automatic game invitations are disabled.');

    for (const guild of readyClient.guilds.cache.values()) {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        if (!member.user.bot || config.allowBotTargets) {
          await db.ensureMember(guild.id, member.id, true);
        }
      }
      console.log(`Synced ${members.size} members for ${guild.name}.`);
    }
  } catch (error) {
    console.error('Startup database sync failed:', error);
  }
});

async function handleAutomationControlMessage(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;
  const command = message.content.trim().toLowerCase();
  if (command !== '!stopic' && command !== '!openic') return;

  if (!hasPermission(message.author.id, message.member?.permissions, PermissionFlagsBits.ManageGuild)) {
    await message.reply({
      content: '❌ You need the Manage Server permission to control Chat Revival and automatic game invitations.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
    return;
  }

  if (command === '!stopic') {
    const result = automationControl.stop();
    gameRotationSystem.pauseInvitations();
    await message.reply({
      content: result.changed
        ? '⏸️ Chat Revival and automatic game invitations are now paused.'
        : 'ℹ️ Chat Revival and automatic game invitations are already paused.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
    return;
  }

  const result = automationControl.open();
  await message.reply({
    content: result.changed
      ? '▶️ Chat Revival and automatic game invitations are now active again.'
      : 'ℹ️ Chat Revival and automatic game invitations are already active.',
    allowedMentions: { parse: [] }
  }).catch(() => {});
}

client.on(Events.GuildMemberAdd, async member => {
  if (!member.user.bot || config.allowBotTargets) {
    await db.setMemberActive(member.guild.id, member.id, true).catch(error => console.error('Member add sync failed:', error));
  }
});

client.on(Events.GuildMemberRemove, async member => {
  await db.setMemberActive(member.guild.id, member.id, false).catch(error => console.error('Member remove sync failed:', error));
});

client.on(Events.MessageDelete, async message => {
  // Chat Revival is intentionally disabled; do not trigger message deletion/revival logic.
});

client.on(Events.MessageCreate, async message => {
  try { await handlePrefixMute(message); } catch (error) { console.error('Prefix mute command failed:', error); }
  try { await staffRanking.handlePrefixMessage(message); } catch (error) { console.error('Staff ranking prefix command failed:', error); }
  try { await staffRanking.handleDiagnosticsMessage(message); } catch (error) { console.error('Staff ranking diagnostics command failed:', error); }
  if (message.guild && !message.author.bot && !message.webhookId) {
    const raw = message.content.trim();
    if (/^!send_news$/i.test(raw)) { if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need Manage Server permission to send manual news.'); try { await newsSystem.sendLatest(client, message); } catch (error) { console.error('Manual news command failed:', error); await message.reply('❌ I could not fetch or post a news story right now.'); } }
    else if (/^!send_qotd$/i.test(raw)) { try { await qotdSystem.sendPanel(message); } catch (error) { console.error('QOTD panel command failed:', error); await message.reply('❌ I could not post the QOTD submission panel.'); } }
    else if (/^!set_qotd_channel\s+/i.test(raw)) { try { await qotdSystem.setChannel(message, raw.split(/\s+/)[1]); } catch (error) { console.error('QOTD channel setup failed:', error); await message.reply('❌ I could not update the QOTD channel.'); } }
    else if (/^!reveal$/i.test(raw)) { try { await mysteryGenSystem.revealCommand(message); } catch (error) { console.error('MysteryGen reveal command failed:', error); await message.reply('I could not reveal the current MysteryGen item.').catch(() => {}); } }
  }
  try { await handlePrefixRoleCommands(message); } catch (error) { console.error('Hoster Manager role command failed:', error); }
  // Automation controls remain inactive while Chat Revival and game invitations are paused.
  // Chat Revival is intentionally disabled; no revival prompts should be sent.
  try { await staffAnalytics.onMessage(message); } catch (error) { console.error('Staff activity tracking failed:', error); }
  try { await learningGames.onMessage(message); } catch (error) { console.error('Learning game message error:', error); }
  try { await wordkillSystem.onMessage(message); } catch (error) { console.error('WordKill message error:', error); }
  try { await politicalTriviaSystem.onMessage(message); } catch (error) { console.error('Political Trivia message error:', error); }
  try { await guessPoliticianSystem.onMessage(message); } catch (error) { console.error('Guess The Politician message error:', error); }
  try { await flagRushSystem.onMessage(message); } catch (error) { console.error('FlagRush message error:', error); }
  try { await mysteryGenSystem.onMessage(message); } catch (error) { console.error('MysteryGen message error:', error); }
  try { await chessPuzzleSystem.onMessage(message); } catch (error) { console.error('Chess Puzzle message error:', error); }
  try { await eventSystem.onMessage(message); } catch (error) { console.error('Event stick error:', error); }
  try { await annihilateSystem.onMessage(message); } catch (error) { console.error('Annihilate message error:', error); }
});


client.on(Events.GuildBanAdd, async ban => {
  try { const logs = await ban.guild.fetchAuditLogs({ type: require('discord.js').AuditLogEvent.MemberBanAdd, limit: 5 }); for (const entry of logs.entries.values()) { if (entry.target?.id === ban.user.id && Date.now() - entry.createdTimestamp < 15000) await staffAnalytics.recordAudit(ban.guild, entry); } } catch (error) { console.error('Ban audit capture failed:', error); }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try { await gameRotationSystem.onReactionAdd(reaction, user); } catch (error) { console.error('Automatic game reaction error:', error); }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('mysterygen:')) return await mysteryGenSystem.onButton(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('qotd:')) return await qotdSystem.onButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('qotd:')) return await qotdSystem.onModal(interaction);
    await handleInteraction(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    const payload = { content: '❌ Something went wrong while processing that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

client.login(config.token);
          

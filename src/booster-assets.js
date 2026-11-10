'use strict';

// Booster perk: lets members who boost the server add custom emojis and a sticker.
//   /booster emoji   name:<text> image:<file>   (up to LIMITS.emoji per booster)
//   /booster sticker name:<text> image:<file>   (up to LIMITS.sticker per booster)
//   /booster status                             (shows how many slots the member has used)
//
// Wiring (see the 3 touch points in commands.js and index.js):
//   - commands.js: `boosterAssets.command` goes in the `commands` array and
//     `boosterAssets.handleCommand(interaction)` is called from handleInteraction.
//   - index.js: `await boosterAssets.migrate();` runs with the other migrations.

const { SlashCommandBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const db = require('./db');

// How many assets each booster may add (lifetime, counted from successful uploads).
const LIMITS = { emoji: 2, sticker: 1 };

// Discord limits: emoji up to 256 KB; sticker PNG/APNG/GIF up to 512 KB and 320x320 px.
const RULES = {
  emoji: {
    maxBytes: 256 * 1024,
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif'],
    extensions: ['.png', '.jpg', '.jpeg', '.gif'],
  },
  sticker: {
    maxBytes: 512 * 1024,
    mimeTypes: ['image/png', 'image/apng', 'image/gif'],
    extensions: ['.png', '.apng', '.gif'],
    maxSide: 320,
  },
};

const EMOJI_NAME = /^[A-Za-z0-9_]{2,32}$/;
const EPHEMERAL = MessageFlags.Ephemeral;

// Prevents a member from firing two uploads at once and slipping past the limit.
const inFlight = new Set();

const command = new SlashCommandBuilder()
  .setName('booster')
  .setDescription('Server booster perks: add your own emojis and sticker.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s => s.setName('emoji').setDescription(`Add a custom emoji to the server (${LIMITS.emoji} per booster).`)
    .addStringOption(o => o.setName('name').setDescription('Emoji name: letters, numbers and underscores.').setRequired(true).setMinLength(2).setMaxLength(32))
    .addAttachmentOption(o => o.setName('image').setDescription('PNG, JPG or GIF, up to 256 KB.').setRequired(true)))
  .addSubcommand(s => s.setName('sticker').setDescription(`Add a custom sticker to the server (${LIMITS.sticker} per booster).`)
    .addStringOption(o => o.setName('name').setDescription('Sticker name (2-30 characters).').setRequired(true).setMinLength(2).setMaxLength(30))
    .addAttachmentOption(o => o.setName('image').setDescription('PNG, APNG or GIF, 320x320 px, up to 512 KB.').setRequired(true))
    .addStringOption(o => o.setName('tags').setDescription('Words that suggest the sticker (defaults to the name).').setMinLength(2).setMaxLength(200))
    .addStringOption(o => o.setName('description').setDescription('Optional description (2-100 characters).').setMinLength(2).setMaxLength(100)))
  .addSubcommand(s => s.setName('status').setDescription('See how many booster emojis and stickers you have used.'));

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS nrr_booster_assets (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('emoji', 'sticker')),
      asset_id TEXT NOT NULL,
      asset_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_nrr_booster_assets_user ON nrr_booster_assets(guild_id, user_id, kind);
  `);
}

async function countUsed(guildId, userId) {
  const { rows } = await db.query(
    'SELECT kind, COUNT(*)::int AS total FROM nrr_booster_assets WHERE guild_id = $1 AND user_id = $2 GROUP BY kind',
    [guildId, userId],
  );
  const used = { emoji: 0, sticker: 0 };
  for (const row of rows) if (row.kind in used) used[row.kind] = row.total;
  return used;
}

function checkFile(kind, attachment) {
  const rules = RULES[kind];
  const type = (attachment.contentType || '').split(';')[0].trim().toLowerCase();
  const extension = (attachment.name || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
  const typeOk = type ? rules.mimeTypes.includes(type) : rules.extensions.includes(extension);
  if (!typeOk) return `Unsupported file type. Allowed: ${rules.extensions.join(', ')}.`;
  if (attachment.size > rules.maxBytes) {
    return `That file is ${Math.ceil(attachment.size / 1024)} KB. The maximum is ${rules.maxBytes / 1024} KB.`;
  }
  if (rules.maxSide && ((attachment.width || 0) > rules.maxSide || (attachment.height || 0) > rules.maxSide)) {
    return `Stickers must be ${rules.maxSide}x${rules.maxSide} px. Yours is ${attachment.width}x${attachment.height}.`;
  }
  return null;
}

function friendlyError(kind, error) {
  switch (error?.code) {
    case 30008: return 'The server has no free emoji slots left.';
    case 30018: return 'The server has no free animated emoji slots left.';
    case 30039: return 'The server has no free sticker slots left.';
    case 50013: return 'I am missing the "Create Expressions" / "Manage Expressions" permission. Ask staff to enable it for me.';
    case 50035:
    case 50045:
    case 50046:
      return kind === 'sticker'
        ? 'Discord rejected that file. Stickers must be PNG, APNG or GIF, exactly 320x320 px and up to 512 KB.'
        : 'Discord rejected that file. Emojis must be PNG, JPG or GIF and up to 256 KB.';
    default: return null;
  }
}

async function isBooster(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(member?.premiumSince);
}

async function add(interaction, kind) {
  const { guild, user } = interaction;
  const key = `${guild.id}:${user.id}`;
  if (inFlight.has(key)) return interaction.editReply('⏳ You already have an upload in progress. Please wait a moment.');
  inFlight.add(key);
  try {
    if (!(await isBooster(guild, user.id))) {
      return interaction.editReply('💎 This perk is only for members who are boosting the server.');
    }

    const used = await countUsed(guild.id, user.id);
    if (used[kind] >= LIMITS[kind]) {
      return interaction.editReply(`❌ You already used all your booster ${kind}s (${used[kind]}/${LIMITS[kind]}).`);
    }

    const name = interaction.options.getString('name', true).trim();
    const file = interaction.options.getAttachment('image', true);
    if (kind === 'emoji' && !EMOJI_NAME.test(name)) {
      return interaction.editReply('❌ Emoji names can only use letters, numbers and underscores (2-32 characters).');
    }
    const fileProblem = checkFile(kind, file);
    if (fileProblem) return interaction.editReply(`❌ ${fileProblem}`);

    const reason = `Booster perk: added by ${user.username} (${user.id}) with /booster ${kind}`;
    let created;
    try {
      if (kind === 'emoji') {
        created = await guild.emojis.create({ attachment: file.url, name, reason });
      } else {
        const tags = interaction.options.getString('tags') || name;
        const description = interaction.options.getString('description') || undefined;
        created = await guild.stickers.create({ file: file.url, name, tags, description, reason });
      }
    } catch (error) {
      const message = friendlyError(kind, error);
      if (!message) console.error(`Booster ${kind} creation error:`, error);
      return interaction.editReply(`❌ ${message || `I could not create that ${kind} right now. Please try again later.`}`);
    }

    try {
      await db.query(
        'INSERT INTO nrr_booster_assets (guild_id, user_id, kind, asset_id, asset_name) VALUES ($1, $2, $3, $4, $5)',
        [guild.id, user.id, kind, created.id, created.name],
      );
    } catch (error) {
      console.error('Booster asset could not be recorded, rolling back:', error);
      await created.delete('Rollback: could not record the booster claim').catch(() => {});
      return interaction.editReply('❌ Something went wrong while saving that. Nothing was added, please try again.');
    }

    const left = LIMITS[kind] - (used[kind] + 1);
    const summary = `You have ${left} ${kind}${left === 1 ? '' : 's'} left.`;
    return interaction.editReply(kind === 'emoji'
      ? `✅ Emoji added: ${created} (\`:${created.name}:\`). ${summary}`
      : `✅ Sticker **${created.name}** added. ${summary}`);
  } finally {
    inFlight.delete(key);
  }
}

async function status(interaction) {
  const { guild, user } = interaction;
  const [booster, used] = await Promise.all([isBooster(guild, user.id), countUsed(guild.id, user.id)]);
  const lines = [
    booster ? '💎 You are boosting the server.' : '💎 You are not boosting the server right now, so you cannot add new ones.',
    `😀 Emojis: **${used.emoji}/${LIMITS.emoji}** used`,
    `🏷️ Sticker: **${used.sticker}/${LIMITS.sticker}** used`,
  ];
  return interaction.editReply(lines.join('\n'));
}

async function handleCommand(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
    return interaction.reply({ content: '❌ This command only works inside the server.', flags: EPHEMERAL });
  }
  const sub = interaction.options.getSubcommand();
  // Uploading can take longer than Discord's 3 second window, so acknowledge first.
  await interaction.deferReply({ flags: EPHEMERAL });
  try {
    if (sub === 'status') return await status(interaction);
    return await add(interaction, sub);
  } catch (error) {
    console.error('Booster assets error:', error);
    await interaction.editReply('❌ Something went wrong. Please try again later.').catch(() => {});
  }
}

module.exports = { command, migrate, handleCommand, LIMITS };

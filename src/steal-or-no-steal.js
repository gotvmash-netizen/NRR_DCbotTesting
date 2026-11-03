const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const db = require('./db');

const PREFIX = 'stealno:';
const GAMES = new Map();
const GOOD_THINGS = [
  '1,000,000, Million Dollars 💰💲',
  '100 Bucks 💵',
  'NR:R Ownership',
  'Pet Cat 🐈',
  '500,000 Dollars 💸',
  '700 Gazillion Dollars 🤑',
  'Teleportation Power',
  'Iron Man Suit',
  '500 Million Subscribers',
  'Cold Pillow',
];
const BAD_THINGS = [
  '1,000,000 Million Dollars Debt 🚨',
  'Death',
  'Prison Ticket',
  '999 Gazillion Dollars Debt 📉',
  'US Army',
  'Angry Lion',
  'Nuclear Missile Inbound',
  'Poisonous Spider',
  'Hot Pillow',
  'NR:R PermBan',
];

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function weightedGoodPosition(counts) {
  const weights = [0, 1, 2].map(position => 1 / (1 + (counts[position] || 0)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (let position = 0; position < weights.length; position++) {
    roll -= weights[position];
    if (roll <= 0) return position;
  }
  return 2;
}

function panel(title, body, rows = []) {
  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (rows.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    for (const row of rows) container.addActionRowComponents(row);
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function button(customId, label, emoji, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);
}

function suitcaseRow(gameId) {
  return new ActionRowBuilder().addComponents(
    button(PREFIX + 'pick:' + gameId + ':0', 'Suitcase 1', '🧳'),
    button(PREFIX + 'pick:' + gameId + ':1', 'Suitcase 2', '🧳'),
    button(PREFIX + 'pick:' + gameId + ':2', 'Suitcase 3', '🧳'),
  );
}

function challengeRow(gameId) {
  return new ActionRowBuilder().addComponents(
    button(PREFIX + 'accept:' + gameId, 'Yes', '✅', ButtonStyle.Success),
    button(PREFIX + 'decline:' + gameId, 'No', '❌', ButtonStyle.Secondary),
  );
}

function decisionRow(gameId, extraTime = true) {
  const row = new ActionRowBuilder().addComponents(
    button(PREFIX + 'steal:' + gameId, 'Steal', '🫳', ButtonStyle.Primary),
    button(PREFIX + 'nosteal:' + gameId, 'No Steal', '🙅', ButtonStyle.Secondary),
  );
  if (extraTime) row.addComponents(button(PREFIX + 'extra:' + gameId, 'Extra 15 Seconds', '⏳'));
  return row;
}

function isPlayer(interaction, userId) {
  return interaction.user.id === userId;
}

function spoilerResult(value) {
  return '||' + value + '||';
}

async function finishGame(game, decision, interaction = null) {
  if (game.finished) return;
  game.finished = true;
  clearTimeout(game.decisionTimer);
  const playerB = '<@' + game.playerB + '>';
  const playerA = '<@' + game.playerA + '>';
  const action = decision === 'steal'
    ? playerB + ' has decided to steal! The suitcase that ' + playerA + ' opened contains...'
    : playerB + ' has decided to not steal! The suitcase that ' + playerA + ' opened has...';
  const reveal = panel('## 🧳 Steal Or No Steal?', action + '\n\n# ' + spoilerResult(game.result) + '\n\n-# Use /steal_or_no_steal to play again!');
  try {
    if (interaction) await interaction.update(reveal);
    else await game.publicMessage.edit(reveal);
  } catch (error) {
    console.error('Steal Or No Steal reveal failed:', error);
  }
  GAMES.delete(game.id);
}

async function showDecision(game) {
  if (game.finished) return;
  game.stage = 'decision';
  const content = panel(
    '## 🧳 Steal Or No Steal?',
    '<@' + game.playerB + '>, it is time to decide! Do you want to steal the suitcase or leave it with ' + '<@' + game.playerA + '>?\n\nYou have **30 seconds** to decide.',
    [decisionRow(game.id, true)]
  );
  await game.publicMessage.edit(content);
  game.decisionTimer = setTimeout(() => finishGame(game, 'nosteal'), 30_000);
}

async function startCommand(interaction) {
  if (!interaction.guildId) return interaction.reply({ content: '❌ This game can only be played inside a server.', ephemeral: true });
  const target = interaction.options.getUser('user', true);
  if (target.bot) return interaction.reply({ content: '❌ You cannot challenge a bot to this game.', ephemeral: true });
  if (target.id === interaction.user.id) return interaction.reply({ content: '❌ You cannot challenge yourself.', ephemeral: true });
  const gameId = interaction.id;
  const challenge = panel(
    '## 🧳 Steal Or No Steal?',
    '<@' + target.id + '>, <@' + interaction.user.id + '> has challenged you to **Steal Or No Steal!**\n\nDo you accept the challenge?',
    [challengeRow(gameId)]
  );
  await interaction.reply({ ...challenge, allowedMentions: { parse: [], users: [target.id, interaction.user.id] } });
  const publicMessage = await interaction.fetchReply();
  GAMES.set(gameId, {
    id: gameId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    playerA: interaction.user.id,
    playerB: target.id,
    publicMessage,
    stage: 'challenge',
    extraUsed: false,
    finished: false,
  });
}

async function onButton(interaction) {
  const [, action, gameId, value] = interaction.customId.split(':');
  const game = GAMES.get(gameId);
  if (!game || game.finished) {
    return interaction.reply({ content: 'This game is no longer active.', ephemeral: true });
  }

  if (action === 'accept' || action === 'decline') {
    if (!isPlayer(interaction, game.playerB)) {
      return interaction.reply({ content: 'Only the challenged player can use these buttons.', ephemeral: true });
    }
    if (game.stage !== 'challenge') return interaction.reply({ content: 'This challenge has already been answered.', ephemeral: true });
    if (action === 'decline') {
      game.finished = true;
      GAMES.delete(gameId);
      return interaction.update(panel(
        '## 🧳 Steal Or No Steal?',
        '<@' + game.playerB + '> has declined the challenge. They chickened out!\n\n-# Use /steal_or_no_steal to play again!'
      ));
    }

    game.stage = 'pick';
    await interaction.update(panel(
      '## 🧳 Steal Or No Steal?',
      '<@' + game.playerA + '>, your turn! Pick a suitcase. One has the good prize, and the other two have bad surprises. Choose wisely...',
    ));
    const counts = await db.query(
      'SELECT position, good_count FROM steal_no_steal_positions WHERE guild_id = $1',
      [game.guildId]
    );
    const positionCounts = [0, 0, 0];
    for (const row of counts.rows) positionCounts[Number(row.position)] = Number(row.good_count);
    const goodPosition = weightedGoodPosition(positionCounts);
    game.contents = [pick(BAD_THINGS), pick(BAD_THINGS), pick(BAD_THINGS)];
    game.contents[goodPosition] = pick(GOOD_THINGS);
    game.goodPosition = goodPosition;
    await db.query(`
      INSERT INTO steal_no_steal_positions (guild_id, position, good_count)
      VALUES ($1, $2, 1)
      ON CONFLICT (guild_id, position)
      DO UPDATE SET good_count = steal_no_steal_positions.good_count + 1
    `, [game.guildId, goodPosition]);
    return interaction.followUp({
      ...panel(
        '## 🧳 Pick Your Suitcase',
        'Pick one of the three suitcases below. One contains a good thing; the other two contain bad things.',
        [suitcaseRow(gameId)]
      ),
      ephemeral: true,
    });
  }

  if (action === 'pick') {
    if (!isPlayer(interaction, game.playerA)) {
      return interaction.reply({ content: 'Only Player A can choose a suitcase.', ephemeral: true });
    }
    if (game.stage !== 'pick') return interaction.reply({ content: 'The suitcase has already been selected.', ephemeral: true });
    const position = Number(value);
    if (![0, 1, 2].includes(position)) return interaction.reply({ content: 'Invalid suitcase selection.', ephemeral: true });
    game.result = game.contents[position];
    game.stage = 'revealed';
    await interaction.update(panel(
      '## 🧳 Your Suitcase',
      '# ' + spoilerResult(game.result) + '\n\n' +
      (game.goodPosition === position
        ? '🎉 Congratulations! Now try to convince <@' + game.playerB + '> not to steal your suitcase.'
        : '😬 Aw shucks! Convince <@' + game.playerB + '> to steal the suitcase so they get it instead of you!')
    ));
    setTimeout(async () => {
      if (game.finished || game.stage !== 'revealed') return;
      await game.publicMessage.edit(panel(
        '## 🧳 Steal Or No Steal?',
        '<@' + game.playerA + '> has picked their suitcase! <@' + game.playerB + '> will now have **30 seconds** to decide.'
      ));
      setTimeout(() => showDecision(game).catch(error => console.error('Steal Or No Steal decision prompt failed:', error)), 30_000);
    }, 5_000);
    return;
  }

  if (action === 'steal' || action === 'nosteal') {
    if (!isPlayer(interaction, game.playerB)) {
      return interaction.reply({ content: 'Only Player B can make this decision.', ephemeral: true });
    }
    if (game.stage !== 'decision') return interaction.reply({ content: 'It is not time to make that decision yet.', ephemeral: true });
    return finishGame(game, action, interaction);
  }

  if (action === 'extra') {
    if (!isPlayer(interaction, game.playerB)) {
      return interaction.reply({ content: 'Only Player B can use the extra-time button.', ephemeral: true });
    }
    if (game.stage !== 'decision') return interaction.reply({ content: 'The decision period is not active.', ephemeral: true });
    if (game.extraUsed) return interaction.reply({ content: 'The extra 15 seconds have already been used.', ephemeral: true });
    game.extraUsed = true;
    clearTimeout(game.decisionTimer);
    game.decisionTimer = setTimeout(() => finishGame(game, 'nosteal'), 15_000);
    return interaction.update(panel(
      '## 🧳 Steal Or No Steal?',
      '<@' + game.playerB + '>, you have **15 extra seconds** to decide!',
      [decisionRow(game.id, false)]
    ));
  }
}

module.exports = { startCommand, onButton };

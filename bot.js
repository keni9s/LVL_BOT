const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Bot is running');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  REST,
  Routes
} = require('discord.js');

const { Pool } = require('pg');

// ===================== POSTGRESQL =====================

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, guild_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      level_up_channel TEXT,
      xp_boost_roles TEXT DEFAULT '[]'
    );
  `);

  console.log('✅ PostgreSQL connected');
}

// ===================== HELPER FUNCTIONS =====================

function getXPRequired(level) {
  return 22 * level;
}

function getTotalXPForLevel(level) {
  let total = 0;

  for (let i = 1; i < level; i++) {
    total += getXPRequired(i);
  }

  return total;
}

async function getUserData(userId, guildId) {
  let result = await pool.query(
    'SELECT * FROM users WHERE user_id = $1 AND guild_id = $2',
    [userId, guildId]
  );

  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (user_id, guild_id, xp, level) VALUES ($1, $2, 0, 1)',
      [userId, guildId]
    );

    result = await pool.query(
      'SELECT * FROM users WHERE user_id = $1 AND guild_id = $2',
      [userId, guildId]
    );
  }

  return result.rows[0];
}

async function getGuildConfig(guildId) {
  let result = await pool.query(
    'SELECT * FROM guild_config WHERE guild_id = $1',
    [guildId]
  );

  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO guild_config (guild_id) VALUES ($1)',
      [guildId]
    );

    result = await pool.query(
      'SELECT * FROM guild_config WHERE guild_id = $1',
      [guildId]
    );
  }

  const config = result.rows[0];

  config.xp_boost_roles = JSON.parse(
    config.xp_boost_roles || '[]'
  );

  return config;
}

async function getLeaderboard(guildId) {
  const result = await pool.query(
    `
      SELECT user_id, xp, level
      FROM users
      WHERE guild_id = $1
      ORDER BY level DESC, xp DESC
    `,
    [guildId]
  );

  return result.rows;
}

const cooldowns = new Map();

// ===================== BOT CLIENT =====================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ===================== REGISTER SLASH COMMANDS =====================

const commands = [
  new SlashCommandBuilder()
    .setName('setlevelchannel')
    .setDescription('Set a channel to announce when a member levels up')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Level-up notification channel')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('setxpboost')
    .setDescription('Set a role to receive bonus XP when chatting')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('Role to receive the XP boost')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('percent')
        .setDescription('XP boost percentage')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(500)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the server leveling leaderboard'),

  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('View your current level and experience')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('View another user rank')
        .setRequired(false)
    ),
];
// ===================== LEADERBOARD EMBED =====================
async function buildLeaderboardEmbed(guild, page, entries) {
  const ITEMS_PER_PAGE = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / ITEMS_PER_PAGE));
  const start = (page - 1) * ITEMS_PER_PAGE;
  const pageEntries = entries.slice(start, start + ITEMS_PER_PAGE);

  const medals = ['🥇', '🥈', '🥉'];

  let description = '';
  for (let i = 0; i < pageEntries.length; i++) {
    const entry = pageEntries[i];
    const rank = start + i + 1;
    const medal = rank <= 3 ? medals[rank - 1] : `**${rank}**`;

    let member;
    try {
      member = await guild.members.fetch(entry.user_id);
    } catch {
      member = null;
    }

    const displayName = member ? member.displayName : `User ${entry.user_id}`;
    const xpNeeded = getXPRequired(entry.level);
    const currentLevelXP = entry.xp - getTotalXPForLevel(entry.level);

    if (rank <= 3) {
      description += `${medal} **@${displayName}** • Level ${entry.level} • **${currentLevelXP}/${xpNeeded}** XP\n\n`;
    } else {
      description += `${medal} @${displayName} • Level ${entry.level} • **${currentLevelXP}/${xpNeeded}** XP\n`;
    }
  }

  if (!description) description = '*No data yet*';

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${guild.name}'s Leveling Leaderboard`)
    .setDescription(description)
    .setColor(0x5865F2)
    .setFooter({ text: `Page ${page}/${totalPages} • ${entries.length} members total` })
    .setTimestamp();

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL());

  return { embed, totalPages };
}

function buildLeaderboardButtons(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lb_first')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId('lb_prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId('lb_page')
      .setLabel(`${page}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('lb_next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === totalPages),
    new ButtonBuilder()
      .setCustomId('lb_last')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === totalPages),
  );
}

// ===================== EVENTS =====================
client.once('ready', async () => {
  console.log(`✅ Bot is online: ${client.user.tag}`);

  const { REST, Routes } = require('discord.js');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('📡 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log('✅ Slash commands registered successfully!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
});

// ===================== XP ON MESSAGE =====================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const guildId = message.guild.id;
  const key = `${userId}-${guildId}`;

  // 60-second cooldown
  const now = Date.now();
  if (cooldowns.has(key) && now - cooldowns.get(key) < 60000) return;
  cooldowns.set(key, now);

  // Get guild config
  const config = await getGuildConfig(guildId);
  const boostRoles = config.xp_boost_roles;

  // Random base XP 1–50
  let xpGain = Math.floor(Math.random() * 50) + 1;

  // Apply role boost
  let boostPercent = 0;
  if (boostRoles.length > 0 && message.member) {
    for (const boostRole of boostRoles) {
      if (message.member.roles.cache.has(boostRole.roleId)) {
        boostPercent += boostRole.percent;
      }
    }
  }
  xpGain = Math.floor(xpGain * (1 + boostPercent / 100));

  // Get user data
  const user = await getUserData(userId, guildId);
  const oldLevel = user.level;

  // Calculate new total XP
  const newTotalXP = user.xp + xpGain;

  // Calculate new level
  let newLevel = oldLevel;
  let xpCheck = newTotalXP;
  while (true) {
    const needed = getTotalXPForLevel(newLevel + 1);
    if (xpCheck >= needed) {
      newLevel++;
    } else {
      break;
    }
    if (newLevel > 9999) break;
  }

  // Update DB
  await pool.query(
  `
    UPDATE users
    SET xp = $1,
        level = $2
    WHERE user_id = $3
      AND guild_id = $4
  `,
  [
    newTotalXP,
    newLevel,
    userId,
    guildId
  ]
);

  // Send level-up notification
  if (newLevel > oldLevel && config.level_up_channel) {
    const channel = message.guild.channels.cache.get(config.level_up_channel);
    if (channel) {
      const xpNeeded = getXPRequired(newLevel);
      const currentLevelXP = newTotalXP - getTotalXPForLevel(newLevel);

      const embed = new EmbedBuilder()
        .setTitle('⬆️ LEVEL UP!')
        .setDescription(`Congratulations ${message.author}! You just reached **Level ${newLevel}**! 🎉`)
        .addFields(
          { name: '📊 Level', value: `${oldLevel} → **${newLevel}**`, inline: true },
          { name: '✨ Experience', value: `${currentLevelXP}/${xpNeeded} XP`, inline: true },
        )
        .setColor(0xFFD700)
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
        .setTimestamp();

      channel.send({ embeds: [embed] });
    }
  }
});

// ===================== SLASH COMMAND HANDLER =====================
client.on('interactionCreate', async (interaction) => {

  // ---- LEADERBOARD BUTTONS ----
  if (interaction.isButton() && interaction.customId.startsWith('lb_')) {
    const entries = await getLeaderboard(interaction.guild.id);
    const totalPages = Math.max(1, Math.ceil(entries.length / 10));
    const currentPage = parseInt(interaction.message.embeds[0]?.footer?.text?.match(/Page (\d+)/)?.[1] || '1');

    let newPage = currentPage;
    if (interaction.customId === 'lb_first') newPage = 1;
    else if (interaction.customId === 'lb_prev') newPage = Math.max(1, currentPage - 1);
    else if (interaction.customId === 'lb_next') newPage = Math.min(totalPages, currentPage + 1);
    else if (interaction.customId === 'lb_last') newPage = totalPages;

    const { embed } = await buildLeaderboardEmbed(interaction.guild, newPage, entries);
    const row = buildLeaderboardButtons(newPage, totalPages);

    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ---- /setlevelchannel ----
  if (commandName === 'setlevelchannel') {
    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild.id;

    await getGuildConfig(guildId); // ensure exists
    await pool.query(
  `
    UPDATE guild_config
    SET level_up_channel = $1
    WHERE guild_id = $2
  `,
  [
    channel.id,
    guildId
  ]
);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Notification channel set')
          .setDescription(`Level-up notifications will now be sent to ${channel}`)
          .setColor(0x57F287)
      ],
      ephemeral: true
    });
  }

  // ---- /setxpboost ----
  else if (commandName === 'setxpboost') {
    const role = interaction.options.getRole('role');
    const percent = interaction.options.getInteger('percent');
    const guildId = interaction.guild.id;

    const config = await getGuildConfig(guildId);
    const roles = config.xp_boost_roles;

    const existing = roles.findIndex(r => r.roleId === role.id);
    if (existing >= 0) {
      roles[existing].percent = percent;
    } else {
      roles.push({ roleId: role.id, percent });
    }

    await pool.query(
  `
    UPDATE guild_config
    SET xp_boost_roles = $1
    WHERE guild_id = $2
  `,
  [
    JSON.stringify(roles),
    guildId
  ]
);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ XP Boost configured')
          .setDescription(`The ${role} role will now earn **+${percent}% XP** per message!`)
          .setColor(0x57F287)
      ],
      ephemeral: true
    });
  }

  // ---- /leaderboard ----
  else if (commandName === 'leaderboard') {
    await interaction.deferReply();

    const entries = await getLeaderboard(interaction.guild.id);
    const totalPages = Math.max(1, Math.ceil(entries.length / 10));
    const { embed } = await buildLeaderboardEmbed(interaction.guild, 1, entries);
    const row = buildLeaderboardButtons(1, totalPages);

    await interaction.editReply({ embeds: [embed], components: [row] });
  }

  // ---- /rank ----
  else if (commandName === 'rank') {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const guildId = interaction.guild.id;
    const user = await getUserData(
  targetUser.id,
  guildId
);

    const xpNeeded = getXPRequired(user.level);
    const totalXPForCurrentLevel = getTotalXPForLevel(user.level);
    const currentLevelXP = user.xp - totalXPForCurrentLevel;
    const xpToNext = getXPRequired(user.level);

    // Rank position
    const leaderboard = await getLeaderboard(
  guildId
);
    const rankPos = leaderboard.findIndex(e => e.user_id === targetUser.id) + 1;

    // Progress bar
    const progressPercent = Math.min(100, Math.floor((currentLevelXP / xpNeeded) * 100));
    const barLength = 20;
    const filled = Math.floor((progressPercent / 100) * barLength);
    const progressBar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${targetUser.username}'s Rank`)
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
      .addFields(
        { name: '🏆 Rank', value: `**#${rankPos}** / ${leaderboard.length}`, inline: true },
        { name: '⭐ Level', value: `**${user.level}**`, inline: true },
        { name: '✨ Total XP', value: `**${user.xp}**`, inline: true },
        { name: `📈 Progress — Level ${user.level} → ${user.level + 1}`, value: `\`${progressBar}\` **${progressPercent}%**\n${currentLevelXP} / ${xpToNext} XP` },
      )
      .setColor(0x5865F2)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
});

// ===================== START BOT =====================
(async () => {
  try {

    await initializeDatabase();

    const token = process.env.DISCORD_TOKEN;

    if (!token) {
      console.error('❌ Missing DISCORD_TOKEN');
      process.exit(1);
    }

    if (!process.env.DATABASE_URL) {
      console.error('❌ Missing DATABASE_URL');
      process.exit(1);
    }

    await client.login(token);

  } catch (err) {
    console.error('❌ Startup Error:', err);
    process.exit(1);
  }
})();
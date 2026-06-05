<?php
$user = requireAuth();
$channelId = (int)($id ?? 0);
if (!$channelId) error('Channel ID required');

$body = json_decode(file_get_contents('php://input'), true) ?? [];
$content = trim($body['content'] ?? '');
if (!$content) error('Message cannot be empty');

$db = getDB();
$channel = $db->query("SELECT id FROM channels WHERE id = $channelId")->fetch();
if (!$channel) error('Channel not found', 404);

$stmt = $db->prepare('INSERT INTO channel_messages (channel_id, user_id, content) VALUES (?, ?, ?)');
$stmt->execute([$channelId, $user['id'], $content]);
$msgId = (int)$db->lastInsertId();

$db->prepare('UPDATE channels SET messages_count = messages_count + 1 WHERE id = ?')->execute([$channelId]);

$msg = $db->query("
    SELECT cm.*, u.username, u.display_name, u.avatar_url, u.verified
    FROM channel_messages cm JOIN users u ON u.id = cm.user_id
    WHERE cm.id = $msgId
")->fetch();

json(['message' => $msg], 201);

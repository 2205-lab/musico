<?php
$channelId = (int)($id ?? 0);
if (!$channelId) error('Channel ID required');
$db = getDB();

$channel = $db->query("SELECT id FROM channels WHERE id = $channelId")->fetch();
if (!$channel) error('Channel not found', 404);

$before = $_GET['before'] ?? null;
$limit  = min(50, max(1, (int)($_GET['limit'] ?? 30)));

$where = "cm.channel_id = $channelId";
$params = [];
if ($before) {
    $where .= " AND cm.id < ?";
    $params[] = (int)$before;
}

$stmt = $db->prepare("
    SELECT cm.*, u.username, u.display_name, u.avatar_url, u.verified
    FROM channel_messages cm
    JOIN users u ON u.id = cm.user_id
    WHERE $where
    ORDER BY cm.id DESC
    LIMIT $limit
");
$stmt->execute($params);
$messages = array_reverse($stmt->fetchAll());

json(['messages' => $messages]);

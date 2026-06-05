<?php
$user = requireAuth();
$db = getDB();

$stmt = $db->prepare("
    SELECT n.*, u.username as from_username, u.display_name as from_name, u.avatar_url as from_avatar
    FROM notifications n
    LEFT JOIN users u ON u.id = n.from_user_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC LIMIT 30
");
$stmt->execute([$user['id']]);
$notifications = $stmt->fetchAll();

$unread = array_filter($notifications, fn($n) => !$n['is_read']);
json(['notifications' => $notifications, 'unread_count' => count($unread)]);

<?php
$db = getDB();
$page   = max(1, (int)($_GET['page'] ?? 1));
$limit  = 10;
$offset = ($page - 1) * $limit;

$stmt = $db->prepare("
    SELECT c.*, u.username, u.display_name, u.avatar_url, u.verified
    FROM collabs c JOIN users u ON u.id = c.user_id
    WHERE c.status = 'open'
    ORDER BY c.created_at DESC
    LIMIT $limit OFFSET $offset
");
$stmt->execute();
json(['collabs' => $stmt->fetchAll()]);

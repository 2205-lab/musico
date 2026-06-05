<?php
$postId = (int)($id ?? 0);
if (!$postId) error('Post ID required');
$db = getDB();

$stmt = $db->prepare('
    SELECT c.*, u.username, u.display_name, u.avatar_url, u.verified
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? AND c.parent_id IS NULL
    ORDER BY c.created_at DESC
    LIMIT 50
');
$stmt->execute([$postId]);
json(['comments' => $stmt->fetchAll()]);

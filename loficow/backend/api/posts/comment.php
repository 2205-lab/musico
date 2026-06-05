<?php
$user = requireAuth();
$postId = (int)($id ?? 0);
$body = json_decode(file_get_contents('php://input'), true) ?? [];
$content = trim($body['content'] ?? '');

if (!$postId) error('Post ID required');
if (!$content) error('Comment cannot be empty');

$db = getDB();
$stmt = $db->prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)');
$stmt->execute([$postId, $user['id'], $content]);
$commentId = (int)$db->lastInsertId();

$db->prepare('UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?')->execute([$postId]);

$post = $db->query("SELECT user_id FROM posts WHERE id = $postId")->fetch();
if ($post && $post['user_id'] !== $user['id']) {
    $db->prepare('INSERT INTO notifications (user_id, from_user_id, type, reference_id, reference_type) VALUES (?,?,?,?,?)')
       ->execute([$post['user_id'], $user['id'], 'comment', $postId, 'post']);
}

$comment = $db->query("
    SELECT c.*, u.username, u.display_name, u.avatar_url, u.verified
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.id = $commentId
")->fetch();

json(['comment' => $comment], 201);

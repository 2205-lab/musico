<?php
$user = requireAuth();
$postId = (int)($id ?? 0);
if (!$postId) error('Post ID required');

$db = getDB();
$post = $db->query("SELECT id, user_id, likes_count FROM posts WHERE id = $postId")->fetch();
if (!$post) error('Post not found', 404);

if ($method === 'POST') {
    try {
        $db->prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)')->execute([$postId, $user['id']]);
        $db->prepare('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?')->execute([$postId]);
        if ($post['user_id'] !== $user['id']) {
            $db->prepare('INSERT INTO notifications (user_id, from_user_id, type, reference_id, reference_type) VALUES (?,?,?,?,?)')
               ->execute([$post['user_id'], $user['id'], 'like', $postId, 'post']);
        }
        json(['liked' => true, 'likes_count' => $post['likes_count'] + 1]);
    } catch (PDOException) {
        json(['liked' => true, 'likes_count' => $post['likes_count']]);
    }
} else {
    $db->prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?')->execute([$postId, $user['id']]);
    $db->prepare('UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ?')->execute([$postId]);
    json(['liked' => false, 'likes_count' => max(0, $post['likes_count'] - 1)]);
}

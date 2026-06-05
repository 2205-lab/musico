<?php
$user = requireAuth();
$targetId = (int)($id ?? 0);
if (!$targetId || $targetId === $user['id']) error('Invalid target user');

$db = getDB();
$target = $db->query("SELECT id FROM users WHERE id = $targetId")->fetch();
if (!$target) error('User not found', 404);

if ($method === 'POST') {
    try {
        $db->prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)')->execute([$user['id'], $targetId]);
        $db->prepare('UPDATE users SET following_count = following_count + 1 WHERE id = ?')->execute([$user['id']]);
        $db->prepare('UPDATE users SET followers_count = followers_count + 1 WHERE id = ?')->execute([$targetId]);
        $db->prepare('INSERT INTO notifications (user_id, from_user_id, type) VALUES (?,?,?)')->execute([$targetId, $user['id'], 'follow']);
        json(['following' => true]);
    } catch (PDOException) {
        json(['following' => true]);
    }
} else {
    $deleted = $db->prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?');
    $deleted->execute([$user['id'], $targetId]);
    if ($deleted->rowCount()) {
        $db->prepare('UPDATE users SET following_count = GREATEST(0, following_count - 1) WHERE id = ?')->execute([$user['id']]);
        $db->prepare('UPDATE users SET followers_count = GREATEST(0, followers_count - 1) WHERE id = ?')->execute([$targetId]);
    }
    json(['following' => false]);
}

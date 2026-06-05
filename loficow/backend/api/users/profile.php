<?php
$currentUser = optionalAuth();
$db = getDB();

$username = $id ?? $_GET['username'] ?? null;
if (!$username) error('Username required');

$stmt = $db->prepare('
    SELECT id, username, display_name, account_type, bio, avatar_url, cover_url,
           website, location, verified, followers_count, following_count, tracks_count, created_at
    FROM users WHERE username = ? LIMIT 1
');
$stmt->execute([$username]);
$user = $stmt->fetch();
if (!$user) error('User not found', 404);

$isFollowing = false;
if ($currentUser) {
    $fStmt = $db->prepare('SELECT id FROM follows WHERE follower_id = ? AND following_id = ? LIMIT 1');
    $fStmt->execute([$currentUser['id'], $user['id']]);
    $isFollowing = (bool)$fStmt->fetch();
}

$user['is_following'] = $isFollowing;
$user['is_own_profile'] = $currentUser && $currentUser['id'] === $user['id'];

json(['user' => $user]);

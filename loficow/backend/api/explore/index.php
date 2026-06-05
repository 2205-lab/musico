<?php
$db = getDB();
$q = trim($_GET['q'] ?? '');
$type = $_GET['type'] ?? 'all';

$result = ['artists' => [], 'beats' => [], 'posts' => []];

if ($type === 'all' || $type === 'artists') {
    $stmt = $db->prepare("
        SELECT id, username, display_name, account_type, bio, avatar_url, verified, followers_count
        FROM users
        WHERE display_name LIKE ? OR username LIKE ? OR bio LIKE ?
        ORDER BY followers_count DESC LIMIT 10
    ");
    $like = "%$q%";
    $stmt->execute([$like, $like, $like]);
    $result['artists'] = $stmt->fetchAll();
}

if ($type === 'all' || $type === 'beats') {
    $stmt = $db->prepare("
        SELECT b.*, u.username, u.display_name, u.avatar_url
        FROM beats b JOIN users u ON u.id = b.user_id
        WHERE b.title LIKE ? OR b.tags LIKE ? OR b.mood LIKE ?
        ORDER BY b.plays_count DESC LIMIT 12
    ");
    $like = "%$q%";
    $stmt->execute([$like, $like, $like]);
    $result['beats'] = $stmt->fetchAll();
}

if ($type === 'all' || $type === 'posts') {
    $stmt = $db->prepare("
        SELECT p.*, u.username, u.display_name, u.avatar_url, u.verified
        FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.content LIKE ? OR p.track_title LIKE ? OR p.tags LIKE ?
        ORDER BY p.likes_count DESC LIMIT 10
    ");
    $like = "%$q%";
    $stmt->execute([$like, $like, $like]);
    $result['posts'] = $stmt->fetchAll();
}

json($result);

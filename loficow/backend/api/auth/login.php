<?php
$body = json_decode(file_get_contents('php://input'), true) ?? [];
$login    = trim($body['login'] ?? '');
$password = $body['password'] ?? '';

if (!$login || !$password) error('Email/username and password required');

$db = getDB();
$stmt = $db->prepare('SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1');
$stmt->execute([$login, $login]);
$user = $stmt->fetch();

if (!$user || !password_verify($password, $user['password'])) {
    error('Invalid credentials', 401);
}

$token = bin2hex(random_bytes(32));
$expires = date('Y-m-d H:i:s', strtotime('+30 days'));
$db->prepare('INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
   ->execute([$user['id'], $token, $expires]);

unset($user['password']);
json(['token' => $token, 'user' => $user]);

<?php
$user = requireAuth();
$headers = getallheaders();
$token = preg_replace('/^Bearer\s+/i', '', $headers['Authorization'] ?? '');
$db = getDB();
$db->prepare('DELETE FROM auth_tokens WHERE token = ?')->execute([$token]);
json(['message' => 'Logged out']);

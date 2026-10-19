// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: © 2026 Parity Technologies
pragma solidity ^0.8.20;

/// @title RedBlackTree — Deployed library for on-chain red-black tree operations.
/// @notice Public functions are called via delegatecall; private helpers are inlined.
/// @dev Follows the red-black tree algorithms of Cormen et al., Introduction to Algorithms (3rd ed.), ch. 13.
/// @custom:security-contact security@parity.io
library RedBlackTree {
    enum Color {
        Red,
        Black
    }

    struct RBNode {
        // --- Slot 1 (216 bits) ---
        uint32 parent;
        uint32 left;
        uint32 right;
        Color color; // 8 bits
        uint96 price;
        uint16 orderCount;
        // --- Slot 2 (192 bits) ---
        uint32 orderHead;
        uint32 orderTail;
        uint128 totalAmount; // aggregate remaining amount at this price level
    }

    // ──────────────── Public functions (delegatecall) ────────────────

    function insert(mapping(uint32 => RBNode) storage nodes, uint32 root, uint32 z)
        public
        returns (uint32)
    {
        uint32 y = 0;
        uint32 x = root;

        while (x != 0) {
            y = x;
            if (nodes[z].price < nodes[x].price) {
                x = nodes[x].left;
            } else {
                x = nodes[x].right;
            }
        }

        nodes[z].parent = y;
        if (y == 0) {
            root = z;
        } else if (nodes[z].price < nodes[y].price) {
            nodes[y].left = z;
        } else {
            nodes[y].right = z;
        }

        nodes[z].left = 0;
        nodes[z].right = 0;
        nodes[z].color = Color.Red;

        return _insertFixup(nodes, root, z);
    }

    function remove(mapping(uint32 => RBNode) storage nodes, uint32 root, uint32 z)
        public
        returns (uint32)
    {
        uint32 y = z;
        Color yOrigColor = nodes[y].color;
        uint32 x;
        uint32 xParent;

        if (nodes[z].left == 0) {
            x = nodes[z].right;
            xParent = nodes[z].parent;
            root = _transplant(nodes, root, z, nodes[z].right);
        } else if (nodes[z].right == 0) {
            x = nodes[z].left;
            xParent = nodes[z].parent;
            root = _transplant(nodes, root, z, nodes[z].left);
        } else {
            y = minimum(nodes, nodes[z].right);
            yOrigColor = nodes[y].color;
            x = nodes[y].right;

            if (nodes[y].parent == z) {
                xParent = y;
                if (x != 0) nodes[x].parent = y;
            } else {
                xParent = nodes[y].parent;
                root = _transplant(nodes, root, y, nodes[y].right);
                nodes[y].right = nodes[z].right;
                nodes[nodes[y].right].parent = y;
            }

            root = _transplant(nodes, root, z, y);
            nodes[y].left = nodes[z].left;
            nodes[nodes[y].left].parent = y;
            nodes[y].color = nodes[z].color;
        }

        if (yOrigColor == Color.Black) {
            root = _deleteFixup(nodes, root, x, xParent);
        }

        // Clean up removed node
        delete nodes[z];

        return root;
    }

    function minimum(mapping(uint32 => RBNode) storage nodes, uint32 x)
        public
        view
        returns (uint32)
    {
        while (nodes[x].left != 0) {
            x = nodes[x].left;
        }
        return x;
    }

    function maximum(mapping(uint32 => RBNode) storage nodes, uint32 x)
        public
        view
        returns (uint32)
    {
        while (nodes[x].right != 0) {
            x = nodes[x].right;
        }
        return x;
    }

    function successor(mapping(uint32 => RBNode) storage nodes, uint32 x)
        public
        view
        returns (uint32)
    {
        if (nodes[x].right != 0) return minimum(nodes, nodes[x].right);
        uint32 y = nodes[x].parent;
        while (y != 0 && x == nodes[y].right) {
            x = y;
            y = nodes[y].parent;
        }
        return y;
    }

    function predecessor(mapping(uint32 => RBNode) storage nodes, uint32 x)
        public
        view
        returns (uint32)
    {
        if (nodes[x].left != 0) return maximum(nodes, nodes[x].left);
        uint32 y = nodes[x].parent;
        while (y != 0 && x == nodes[y].left) {
            x = y;
            y = nodes[y].parent;
        }
        return y;
    }

    // ──────────────── Private helpers (inlined) ────────────────

    function _insertFixup(mapping(uint32 => RBNode) storage nodes, uint32 root, uint32 z)
        private
        returns (uint32)
    {
        while (z != root && nodes[nodes[z].parent].color == Color.Red) {
            uint32 zParent = nodes[z].parent;
            uint32 zGrandparent = nodes[zParent].parent;

            if (zParent == nodes[zGrandparent].left) {
                uint32 uncle = nodes[zGrandparent].right;
                if (uncle != 0 && nodes[uncle].color == Color.Red) {
                    nodes[zParent].color = Color.Black;
                    nodes[uncle].color = Color.Black;
                    nodes[zGrandparent].color = Color.Red;
                    z = zGrandparent;
                } else {
                    if (z == nodes[zParent].right) {
                        z = zParent;
                        root = _leftRotate(nodes, root, z);
                        zParent = nodes[z].parent;
                        zGrandparent = nodes[zParent].parent;
                    }
                    nodes[zParent].color = Color.Black;
                    nodes[zGrandparent].color = Color.Red;
                    root = _rightRotate(nodes, root, zGrandparent);
                }
            } else {
                uint32 uncle = nodes[zGrandparent].left;
                if (uncle != 0 && nodes[uncle].color == Color.Red) {
                    nodes[zParent].color = Color.Black;
                    nodes[uncle].color = Color.Black;
                    nodes[zGrandparent].color = Color.Red;
                    z = zGrandparent;
                } else {
                    if (z == nodes[zParent].left) {
                        z = zParent;
                        root = _rightRotate(nodes, root, z);
                        zParent = nodes[z].parent;
                        zGrandparent = nodes[zParent].parent;
                    }
                    nodes[zParent].color = Color.Black;
                    nodes[zGrandparent].color = Color.Red;
                    root = _leftRotate(nodes, root, zGrandparent);
                }
            }
        }
        nodes[root].color = Color.Black;
        return root;
    }

    function _deleteFixup(
        mapping(uint32 => RBNode) storage nodes,
        uint32 root,
        uint32 x,
        uint32 xParent
    ) private returns (uint32) {
        while (x != root && (x == 0 || nodes[x].color == Color.Black)) {
            if (x == nodes[xParent].left) {
                uint32 w = nodes[xParent].right;
                if (w != 0 && nodes[w].color == Color.Red) {
                    nodes[w].color = Color.Black;
                    nodes[xParent].color = Color.Red;
                    root = _leftRotate(nodes, root, xParent);
                    w = nodes[xParent].right;
                }
                bool leftBlack = nodes[w].left == 0 || nodes[nodes[w].left].color == Color.Black;
                bool rightBlack = nodes[w].right == 0 || nodes[nodes[w].right].color == Color.Black;
                if (leftBlack && rightBlack) {
                    if (w != 0) nodes[w].color = Color.Red;
                    x = xParent;
                    xParent = nodes[x].parent;
                } else {
                    if (rightBlack) {
                        if (nodes[w].left != 0) nodes[nodes[w].left].color = Color.Black;
                        nodes[w].color = Color.Red;
                        root = _rightRotate(nodes, root, w);
                        w = nodes[xParent].right;
                    }
                    nodes[w].color = nodes[xParent].color;
                    nodes[xParent].color = Color.Black;
                    if (nodes[w].right != 0) nodes[nodes[w].right].color = Color.Black;
                    root = _leftRotate(nodes, root, xParent);
                    x = root;
                }
            } else {
                uint32 w = nodes[xParent].left;
                if (w != 0 && nodes[w].color == Color.Red) {
                    nodes[w].color = Color.Black;
                    nodes[xParent].color = Color.Red;
                    root = _rightRotate(nodes, root, xParent);
                    w = nodes[xParent].left;
                }
                bool leftBlack = nodes[w].left == 0 || nodes[nodes[w].left].color == Color.Black;
                bool rightBlack = nodes[w].right == 0 || nodes[nodes[w].right].color == Color.Black;
                if (leftBlack && rightBlack) {
                    if (w != 0) nodes[w].color = Color.Red;
                    x = xParent;
                    xParent = nodes[x].parent;
                } else {
                    if (leftBlack) {
                        if (nodes[w].right != 0) nodes[nodes[w].right].color = Color.Black;
                        nodes[w].color = Color.Red;
                        root = _leftRotate(nodes, root, w);
                        w = nodes[xParent].left;
                    }
                    nodes[w].color = nodes[xParent].color;
                    nodes[xParent].color = Color.Black;
                    if (nodes[w].left != 0) nodes[nodes[w].left].color = Color.Black;
                    root = _rightRotate(nodes, root, xParent);
                    x = root;
                }
            }
        }
        if (x != 0) nodes[x].color = Color.Black;
        return root;
    }

    function _transplant(mapping(uint32 => RBNode) storage nodes, uint32 root, uint32 u, uint32 v)
        private
        returns (uint32)
    {
        if (nodes[u].parent == 0) {
            root = v;
        } else if (u == nodes[nodes[u].parent].left) {
            nodes[nodes[u].parent].left = v;
        } else {
            nodes[nodes[u].parent].right = v;
        }
        if (v != 0) {
            nodes[v].parent = nodes[u].parent;
        }
        return root;
    }

    function _leftRotate(mapping(uint32 => RBNode) storage nodes, uint32 root, uint32 x)
        private
        returns (uint32)
    {
        uint32 y = nodes[x].right;
        nodes[x].right = nodes[y].left;
        if (nodes[y].left != 0) {
            nodes[nodes[y].left].parent = x;
        }
        nodes[y].parent = nodes[x].parent;
        if (nodes[x].parent == 0) {
            root = y;
        } else if (x == nodes[nodes[x].parent].left) {
            nodes[nodes[x].parent].left = y;
        } else {
            nodes[nodes[x].parent].right = y;
        }
        nodes[y].left = x;
        nodes[x].parent = y;
        return root;
    }

    function _rightRotate(mapping(uint32 => RBNode) storage nodes, uint32 root, uint32 x)
        private
        returns (uint32)
    {
        uint32 y = nodes[x].left;
        nodes[x].left = nodes[y].right;
        if (nodes[y].right != 0) {
            nodes[nodes[y].right].parent = x;
        }
        nodes[y].parent = nodes[x].parent;
        if (nodes[x].parent == 0) {
            root = y;
        } else if (x == nodes[nodes[x].parent].right) {
            nodes[nodes[x].parent].right = y;
        } else {
            nodes[nodes[x].parent].left = y;
        }
        nodes[y].right = x;
        nodes[x].parent = y;
        return root;
    }
}

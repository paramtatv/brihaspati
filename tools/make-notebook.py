#!/usr/bin/env python3
"""notebooks/demo.ipynb: one code cell per cells/*.t1, in name order (the notebook test runs all of them)."""
import json, glob, os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
names = sorted(os.path.basename(f) for f in glob.glob(os.path.join(root, 'cells', '*.t1')))
cells = [{"cell_type": "code", "execution_count": None, "metadata": {"cell": n}, "outputs": [], "source": open(os.path.join(root, 'cells', n), encoding='utf8').read()} for n in names]
nb = {"cells": cells, "metadata": {"kernelspec": {"name": "brihaspati", "display_name": "बृहस्पति", "language": "sassembly"}, "language_info": {"name": "sassembly"}}, "nbformat": 4, "nbformat_minor": 5}
os.makedirs(os.path.join(root, 'notebooks'), exist_ok=True)
json.dump(nb, open(os.path.join(root, 'notebooks', 'demo.ipynb'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
